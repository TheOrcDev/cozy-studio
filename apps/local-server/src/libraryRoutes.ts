import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { Hono } from 'hono';
import type { resolvePublicLibraryPath } from './library';
import {
  buildLibraryAssetHeaders,
  ensureThumbnailVariant,
  resolveAssetCacheSeconds,
  resolveThumbnailMaxEdge,
} from './libraryAssetVariants';
import type { log } from './logger';
import { isPublicLibraryAssetPath } from './publicLibraryAssetPolicy';

interface LibraryRoutesDependencies {
  resolvePublicLibraryPath: typeof resolvePublicLibraryPath;
  resolvePublicLibraryAssetRequest?: (
    relativePath: string,
  ) => { filePath: string; assetRelativePath: string } | null;
  ensureThumbnailVariant: typeof ensureThumbnailVariant;
  buildLibraryAssetHeaders: typeof buildLibraryAssetHeaders;
  resolveAssetCacheSeconds: typeof resolveAssetCacheSeconds;
  resolveThumbnailMaxEdge: typeof resolveThumbnailMaxEdge;
  isPublicLibraryAssetPath?: typeof isPublicLibraryAssetPath;
  fileExists?: (filePath: string) => boolean;
  createFileResponse?: (filePath: string) => Response;
  /** Hosted mode downloads the file from object storage before the existence check. */
  prepareFile?: (filePath: string) => Promise<void>;
  logger?: typeof log;
}

// Bun streams with Bun.file; hosted mode runs on Node (ADR 0013).
function createPortableFileResponse(filePath: string) {
  if (typeof Bun !== 'undefined') return new Response(Bun.file(filePath));
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream);
}

export function createLibraryRoutes({
  resolvePublicLibraryPath,
  resolvePublicLibraryAssetRequest,
  ensureThumbnailVariant,
  buildLibraryAssetHeaders,
  resolveAssetCacheSeconds,
  resolveThumbnailMaxEdge,
  isPublicLibraryAssetPath: canServePublicLibraryAsset = isPublicLibraryAssetPath,
  fileExists = existsSync,
  createFileResponse = createPortableFileResponse,
  prepareFile,
  logger,
}: LibraryRoutesDependencies) {
  const routes = new Hono();

  routes.get('/library/*', async (c) => {
    const encoded = c.req.path.replace('/library/', '');
    let relative = '';
    try {
      relative = decodeURIComponent(encoded);
    } catch {
      return c.notFound();
    }
    const resolved = resolvePublicLibraryAssetRequest?.(relative) ?? {
      filePath: resolvePublicLibraryPath(relative),
      assetRelativePath: relative,
    };
    if (!resolved || !canServePublicLibraryAsset(resolved.assetRelativePath)) return c.notFound();
    const filePath = resolved.filePath;
    await prepareFile?.(filePath);
    if (!fileExists(filePath)) return c.notFound();

    const url = new URL(c.req.url);
    const variant = url.searchParams.get('variant');
    let servedPath = filePath;

    if (variant === 'thumb') {
      try {
        servedPath = await ensureThumbnailVariant(filePath, {
          maxEdge: resolveThumbnailMaxEdge(url.searchParams.get('max')),
        });
      } catch (error) {
        logger?.(
          'warn',
          'library',
          `Thumbnail generation failed for ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const fileResponse = createFileResponse(servedPath);
    const headers = buildLibraryAssetHeaders(servedPath, {
      cacheSeconds: resolveAssetCacheSeconds(variant),
    });

    return new Response(fileResponse.body, {
      status: fileResponse.status,
      statusText: fileResponse.statusText,
      headers,
    });
  });

  return routes;
}
