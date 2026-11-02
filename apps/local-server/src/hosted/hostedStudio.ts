import { existsSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@neon/functions';
import type { Hono } from 'hono';

import type { Job } from '../../../../packages/shared/src';
import { EXTENSION_MANIFEST_FILE } from '../../../../packages/shared/src/extensions';
import { createStudioApp, type StudioAppInstance } from '../appFactory';
import { setSubscriptionAuthStore } from '../auth/store';
import { setCatalogFileExistenceCheck } from '../catalog';
import { getSettings } from '../config';
import { getDb } from '../db/connection';
import { listRecoverableJobs } from '../db/jobs';
import { migrateDb } from '../db/migrations';
import { setStudioEventSink } from '../events';
import { createExtensionStore, resolveExtensionSources } from '../extensionStore';
import { resolvePublicLibraryAssetRequest } from '../libraries';
import { resolveLibraryPathFromRoot, resolvePublicLibraryPath } from '../library';
import { buildLibraryAssetHeaders, resolveThumbnailMaxEdge } from '../libraryAssetVariants';
import { log } from '../logger';
import { applyHostedEnvironment, HOSTED_ROOT, requireHostedSetting } from './hostedEnvironment';
import { createHostedEventFeed, createHostedEventSink, pruneHostedEvents } from './hostedEvents';
import { createHostedJobRuntime } from './hostedJobs';
import { createHostedMcpRoutes } from './hostedMcp';
import { createHostedSecurityMiddleware, createOwnerSessionRoutes } from './hostedSecurity';
import { createLibraryMirror, resetHostedRoot, thumbnailCacheKey } from './libraryMirror';
import { createNeonAuthProxyRoutes } from './neonAuthProxy';
import { createSealedSubscriptionAuthStore } from './sealedCredentialStore';

const EXTENSIONS_PREFIX = 'Extensions/';
const EXTENSION_REFRESH_MS = 15_000;

function jobFilePaths(job: Job) {
  return [
    ...(job.sourceSpec?.assets ?? []).map((asset) => asset.localPath),
    job.finalization?.sourcePath,
    job.finalization?.filePath,
  ];
}

function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function background(promise: Promise<unknown>, label: string) {
  waitUntil(
    promise.catch((error) =>
      log(
        'warn',
        'hosted',
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
}

export async function createHostedStudio(): Promise<StudioAppInstance> {
  applyHostedEnvironment();
  const sessionSecret = requireHostedSetting('STUDIO_SESSION_SECRET');
  const credentialKey = requireHostedSetting('STUDIO_SECRET_KEY');
  const ownerEmail = requireHostedSetting('STUDIO_OWNER_EMAIL');
  const bucket = requireHostedSetting('STUDIO_LIBRARY_BUCKET');
  const publicOrigin = requireHostedSetting('STUDIO_PUBLIC_ORIGIN');
  const sweepSecret = requireHostedSetting('STUDIO_SWEEP_SECRET');
  const extraOrigins = (process.env.STUDIO_ALLOWED_ORIGINS ?? '')
    .split(/[;,]/)
    .map((origin) => origin.trim())
    .filter(Boolean);

  resetHostedRoot(HOSTED_ROOT);
  const database = () => getDb();
  // Tables must exist before the first event or log line is written.
  migrateDb();
  setSubscriptionAuthStore(
    createSealedSubscriptionAuthStore({ database: getDb(), secret: credentialKey }),
  );
  const eventSink = createHostedEventSink(database);
  setStudioEventSink(eventSink);
  const eventFeed = createHostedEventFeed(database, eventSink);

  const mirror = createLibraryMirror({ root: HOSTED_ROOT, bucket });
  setCatalogFileExistenceCheck((filePath) => mirror.knownToExist(filePath));
  const syncLibrary = () => background(mirror.sync(), 'Library upload');
  // Extension listings scan manifests on disk. Every other style pack file downloads when first
  // read, and a sync afterwards keeps downloaded images within the local budget.
  await mirror.hydrateFolders(EXTENSIONS_PREFIX, EXTENSION_MANIFEST_FILE);
  const extensionStore = createExtensionStore(resolveExtensionSources(), {
    prepareFile: async (filePath) => {
      if (existsSync(filePath)) return;
      if (await mirror.hydrate(filePath)) syncLibrary();
    },
  });
  // Style packs another instance installed, updated or removed appear on this one's next listing.
  let extensionsCheckedAt = Date.now();
  let extensionsRefresh: Promise<void> = Promise.resolve();
  const refreshExtensions = () => {
    if (Date.now() - extensionsCheckedAt < EXTENSION_REFRESH_MS) return extensionsRefresh;
    extensionsCheckedAt = Date.now();
    extensionsRefresh = mirror
      .hydrateFolders(EXTENSIONS_PREFIX, EXTENSION_MANIFEST_FILE)
      .then(async (changed) => {
        if (changed > 0) await extensionStore.list({ refresh: true });
      })
      .catch((error) =>
        log(
          'warn',
          'hosted',
          `Style pack refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return extensionsRefresh;
  };

  let sweep: (() => { adopted: number }) | null = null;

  const attach = (app: Hono, worker: Parameters<typeof createHostedJobRuntime>[0]['worker']) => {
    const runtime = createHostedJobRuntime({
      database,
      worker,
      waitUntil,
      prepareJob: (job) => mirror.hydrateAll(jobFilePaths(job)),
      afterIdle: () => mirror.sync(),
      listRecoverableJobs,
      logger: log,
    });
    sweep = runtime.sweep;

    // Upload whatever a request wrote (references, thumbnails, installed style packs).
    app.use('*', async (c, next) => {
      await next();
      if (c.req.method !== 'GET' || c.req.path.startsWith('/library/')) syncLibrary();
    });

    // Thumbnails are served without downloading the full-size source when one already exists.
    app.get('/library/*', async (c, next) => {
      if (c.req.query('variant') !== 'thumb') return next();
      let relative: string;
      try {
        relative = decodeURIComponent(c.req.path.replace('/library/', ''));
      } catch {
        return next();
      }
      const sourcePath =
        resolvePublicLibraryAssetRequest(relative)?.filePath ?? resolvePublicLibraryPath(relative);
      if (!sourcePath) return next();
      const libraryDir = getSettings().libraryDir;
      const remote = await mirror.head(sourcePath);
      if (!remote || !remote.mtimeMs) return next();
      const maxEdge = resolveThumbnailMaxEdge(c.req.query('max'));
      const relativeSource = path.relative(libraryDir, sourcePath).split(path.sep).join('/');
      const thumbnailPath = resolveLibraryPathFromRoot(
        libraryDir,
        'thumbnails',
        `${thumbnailCacheKey(relativeSource, remote.size, remote.mtimeMs, maxEdge)}.${maxEdge}.webp`,
      );
      if (!(await mirror.hydrate(thumbnailPath))) return next();
      const { readFile } = await import('node:fs/promises');
      return new Response(new Uint8Array(await readFile(thumbnailPath)), {
        headers: buildLibraryAssetHeaders(thumbnailPath, { cacheSeconds: 24 * 60 * 60 }),
      });
    });

    app.get('/api/extensions', async (_c, next) => {
      await refreshExtensions();
      await next();
    });
    // Files of a removed pack that this instance never downloaded go from storage too.
    app.delete('/api/extensions/:id', async (c, next) => {
      const id = c.req.param('id');
      const extension = (await extensionStore.list()).extensions.find(
        (item) => item.manifest.id === id,
      );
      await next();
      if (c.res.status !== 204 || !extension) return;
      const folder = path.relative(HOSTED_ROOT, extension.root).split(path.sep).join('/');
      if (folder.startsWith(EXTENSIONS_PREFIX)) {
        background(mirror.removePrefix(`${folder}/`), 'Style pack removal');
      }
    });

    app.post('/internal/sweep/:secret', (c) => {
      if (!sameSecret(c.req.param('secret'), sweepSecret)) return c.json({ ok: false }, 404);
      const result = sweep?.() ?? { adopted: 0 };
      pruneHostedEvents(getDb());
      syncLibrary();
      return c.json({ ok: true, ...result });
    });

    const neonAuthBaseUrl = process.env.NEON_AUTH_BASE_URL;
    const neonAuthJwksUrl =
      process.env.NEON_AUTH_JWKS_URL ??
      (neonAuthBaseUrl ? `${neonAuthBaseUrl.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);
    if (neonAuthBaseUrl && neonAuthJwksUrl) {
      app.route('/', createNeonAuthProxyRoutes({ baseUrl: neonAuthBaseUrl }));
      app.route(
        '/',
        createOwnerSessionRoutes({
          database,
          sessionSecret,
          ownerEmail,
          neonAuthBaseUrl,
          neonAuthJwksUrl,
        }),
      );
    }

    app.route(
      '/mcp',
      createHostedMcpRoutes({
        request: (requestPath, init) => app.request(requestPath, init),
        publicOrigin,
        sessionSecret,
      }),
    );

    return runtime.worker;
  };

  const studio = await createStudioApp({
    dependencies: { extensionStore },
    hosted: {
      security: createHostedSecurityMiddleware({
        database,
        sessionSecret,
        allowedOrigins: [publicOrigin, ...extraOrigins],
      }),
      attach,
      subscribeEvents: (listener) => eventFeed.subscribe(listener),
      readEventRevision: () => eventSink.currentRevision(),
      prepareLibraryFile: async (filePath) => {
        await mirror.hydrate(filePath);
      },
    },
  });

  // Adopt work an evicted instance left behind.
  background(
    Promise.resolve().then(() => sweep?.()),
    'Startup sweep',
  );
  return studio;
}
