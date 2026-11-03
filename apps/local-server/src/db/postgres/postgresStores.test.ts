import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listCatalogFacets,
  queryCatalog,
  queryCatalogWorkspaceSummaries,
  registerCatalogImage,
  updateCatalogImage,
} from '../../catalog';
import {
  createCatalogCollection,
  listCatalogCollections,
  listCatalogOrganizeHistory,
  organizeCatalogImages,
  undoCatalogOrganize,
  updateCatalogCollection,
} from '../../catalogCollections';
import { suggestCatalogOrganization } from '../../catalogOrganize';
import { listCatalogTags, updateCatalogTag } from '../../catalogTags';
import { ensureDefaultLibrary, listLibraries } from '../../libraries';
import type { PreparedPersistentJob } from '../../persistentJobIntake';
import { createSqliteUserStyleStore } from '../../sqliteUserStyles';
import { findCatalogDuplicates } from '../../storageMaintenance';
import { setDefaultDb } from '../connection';
import { addJobEvent, addSystemLog, listJobEvents, listLogs } from '../events';
import { createJobBatch, getJobBatch } from '../jobBatches';
import {
  createJob,
  getJob,
  listJobSummaries,
  listRecoverableJobs,
  requeueJob,
  updateJobRemoteExecution,
  updateJobStatus,
} from '../jobs';
import { LATEST_DATABASE_SCHEMA_VERSION, migrateDb } from '../migrations';
import { getOutputGeneration } from '../outputGenerations';
import { getSettingValue, setSettingValue } from '../settings';
import {
  createWorkspaceInDb,
  deleteWorkspaceFromDb,
  ensureDefaultWorkspace,
  listWorkspaces,
} from '../workspaces';
import { latestPostgresSchemaVersion } from './postgresSchema';
import { createSqliteCompatPostgresDatabase, isPostgresDatabase } from './sqliteCompatDatabase';
import { createSyncPostgresClient } from './syncPostgresBridge';

// Runs the real stores against Postgres (PGlite in a worker) through the synchronous bridge, so
// SQL that only SQLite accepts fails here instead of in hosted mode.
describe('stores on Postgres', () => {
  let db: Database;
  let libraryDir: string;
  const previousLibraryDir = process.env.STUDIO_LIBRARY_DIR;

  beforeAll(() => {
    libraryDir = mkdtempSync(path.join(tmpdir(), 'cozy-pg-stores-'));
    process.env.STUDIO_LIBRARY_DIR = libraryDir;
    db = createSqliteCompatPostgresDatabase(createSyncPostgresClient({ kind: 'pglite' }));
    setDefaultDb(db);
    migrateDb(db);
  }, 60_000);

  afterAll(() => {
    setDefaultDb(null);
    db?.close();
    rmSync(libraryDir, { recursive: true, force: true });
    if (previousLibraryDir === undefined) delete process.env.STUDIO_LIBRARY_DIR;
    else process.env.STUDIO_LIBRARY_DIR = previousLibraryDir;
  });

  it('keeps the Postgres schema in step with the SQLite migrations', () => {
    expect(isPostgresDatabase(db)).toBe(true);
    expect(latestPostgresSchemaVersion()).toBe(LATEST_DATABASE_SCHEMA_VERSION);
    expect(() => migrateDb(db)).not.toThrow();
  });

  it('stores settings, libraries and workspaces', () => {
    setSettingValue('example', 'one');
    setSettingValue('example', 'two');
    expect(getSettingValue('example')).toBe('two');
    const library = ensureDefaultLibrary();
    expect(library.isDefault).toBe(true);
    expect(ensureDefaultLibrary().id).toBe(library.id);
    expect(listLibraries().length).toBeGreaterThan(0);
    ensureDefaultWorkspace();
    expect(listWorkspaces().map((workspace) => workspace.id)).toContain('default');
  });

  it('runs the job lifecycle, events and logs', () => {
    const job = createJob({
      kind: 'image_generate',
      prompt: 'a cozy cabin',
      providerId: 'chatgpt',
    });
    expect(getJob(job.id)?.status).toBe('queued');
    expect(listRecoverableJobs().map((item) => item.id)).toContain(job.id);

    updateJobRemoteExecution(job.id, { phase: 'failed', providerId: 'chatgpt' } as never);
    updateJobStatus(job.id, 'failed', 'boom');
    const requeued = requeueJob(job.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempt).toBe(2);
    expect(getJob(job.id)?.remoteExecution ?? null).toBeNull();

    addJobEvent(job.id, 'job.note', 'hello', { a: 1 });
    expect(listJobEvents(job.id).at(-1)?.message).toBe('hello');
    const log = addSystemLog({ level: 'info', scope: 'test', message: 'logged', jobId: job.id });
    expect(log?.message).toBe('logged');
    expect(listLogs().some((entry) => entry.message === 'logged')).toBe(true);

    const summaries = listJobSummaries({ limit: 5 });
    expect(summaries.counts).toBeDefined();
  });

  it('allocates output generations and batches atomically', () => {
    const first = getOutputGeneration('owner-a');
    expect(getOutputGeneration('owner-a')).toBe(first);
    expect(getOutputGeneration('owner-b')).toBeGreaterThan(first);

    const item = {
      input: { kind: 'image_generate', prompt: 'batch item' },
      finalPrompt: 'batch item',
    } as PreparedPersistentJob;
    const created = createJobBatch('batch-test', 'hash-1', [item, item]);
    expect(created.created).toBe(true);
    expect(createJobBatch('batch-test', 'hash-1', [item, item]).created).toBe(false);
    expect(getJobBatch('batch-test')?.jobs.length).toBe(2);
  });

  it('searches, sorts and summarises the catalog, tags and collections', () => {
    const library = ensureDefaultLibrary();
    const register = (prompt: string, tags: string[]) =>
      registerCatalogImage({
        libraryId: library.id,
        filePath: path.join(libraryDir, 'outputs', `${prompt}.png`),
        prompt,
        mimeType: 'image/png',
        workspaceId: 'default',
        fileSizeBytes: 100,
        tags,
      } as never);
    const banana = register('Banana boat', ['Fruit', 'boat']);
    register('apple tree', ['fruit']);

    expect(queryCatalog({ q: '#fruit', limit: 10 } as never).images.length).toBe(2);
    expect(
      queryCatalog({ q: 'BANANA', limit: 10 } as never).images.map((image) => image.id),
    ).toEqual([banana.id]);
    expect(queryCatalog({ sort: 'prompt', limit: 10 } as never).images[0]?.prompt).toBe(
      'apple tree',
    );
    const summary = queryCatalogWorkspaceSummaries().find((item) => item.workspaceId === 'default');
    expect(summary?.imageCount).toBe(2);

    expect(listCatalogTags('default').find((tag) => tag.name === 'boat')?.imageCount).toBe(1);
    updateCatalogTag('default', 'boat', { name: 'ship' });
    expect(listCatalogTags('default').some((tag) => tag.name === 'ship')).toBe(true);

    const collection = createCatalogCollection({
      workspaceId: 'default',
      name: 'Faves',
      imageIds: [banana.id, banana.id],
    });
    expect(listCatalogCollections('default')[0]?.imageCount).toBe(1);
    expect(() =>
      createCatalogCollection({ workspaceId: 'default', name: 'faves', imageIds: [banana.id] }),
    ).toThrow();
    expect(updateCatalogCollection(collection.id, { name: 'Favorites' })?.name).toBe('Favorites');
  });

  it('filters smart collections, facets and duplicates, and organizes with undo', async () => {
    const library = ensureDefaultLibrary();
    const workspace = createWorkspaceInDb(db, { name: 'Smart' });
    const register = (prompt: string, extra: Record<string, unknown> = {}) =>
      registerCatalogImage({
        libraryId: library.id,
        filePath: path.join(libraryDir, 'outputs', `${prompt}.png`),
        prompt,
        mimeType: 'image/png',
        workspaceId: workspace.id,
        ...extra,
      } as never);
    const styled = register('styled cat', {
      tags: ['cat'],
      collectionName: 'Pets',
      isFavorite: true,
      recipeId: 'styles',
      createdAt: '2026-11-01T10:00:00Z',
      generationConfig: {
        providerId: 'grok',
        recipeParams: {
          presetId: 'ink',
          presetName: 'Ink',
          selectedStyles: [{ presetId: 'neon', presetName: 'Neon' }, 'not-a-style'],
        },
      },
    });
    const plain = register('plain dog', { generationConfig: 'not json' });

    expect(listCatalogCollections(workspace.id).find((c) => c.name === 'Pets')?.imageCount).toBe(1);
    const unorganized = { workspaceId: workspace.id, unorganized: true, limit: 10 } as never;
    expect(queryCatalog(unorganized).images.map((image) => image.id)).toEqual([plain.id]);
    expect(queryCatalog({ workspaceId: workspace.id, favorite: true } as never).total).toBe(1);
    const manyTags = Array.from({ length: 33 }, (_, index) => `#t${index}`).join(' ');
    expect(queryCatalog({ workspaceId: workspace.id, q: manyTags } as never).total).toBe(0);

    const smart = (rule: Record<string, unknown>) =>
      queryCatalog({
        workspaceId: workspace.id,
        collectionId: createCatalogCollection({
          workspaceId: workspace.id,
          name: `Rule ${JSON.stringify(rule)}`,
          imageIds: [],
          rule,
        } as never).id,
      } as never).images.map((image) => image.id);
    expect(smart({ providerId: 'grok' })).toEqual([styled.id]);
    expect(smart({ stylePresetId: 'neon' })).toEqual([styled.id]);
    expect(smart({ stylePresetId: 'ink', recipeId: 'default' })).toEqual([styled.id]);
    expect(
      smart({ createdFrom: '2026-11-01T09:00:00.000Z', createdTo: '2026-11-01T11:00:00Z' }),
    ).toEqual([styled.id]);
    expect(smart({ withinDays: 1 })).toEqual([plain.id]);
    expect(smart({ q: '#CAT' })).toEqual([styled.id]);

    const facets = listCatalogFacets(workspace.id);
    expect(facets.providers).toEqual([{ id: 'grok', count: 1 }]);
    expect(facets.recipes).toEqual([{ id: 'default', count: 2 }]);
    expect(facets.styles).toEqual([
      { presetId: 'ink', name: 'Ink', count: 1 },
      { presetId: 'neon', name: 'Neon', count: 1 },
    ]);

    const organized = organizeCatalogImages({
      source: 'agent',
      workspaceId: workspace.id,
      imageIds: [plain.id],
      addTags: ['dog'],
      addToCollection: 'Pets',
    });
    expect(organized.operationId).toBeTruthy();
    expect(listCatalogOrganizeHistory(workspace.id)[0]?.operationId).toBe(organized.operationId);
    expect(queryCatalog(unorganized).total).toBe(0);
    expect(undoCatalogOrganize(organized.operationId!)?.alreadyUndone).toBe(false);
    expect(queryCatalog(unorganized).total).toBe(1);
    expect(suggestCatalogOrganization(workspace.id).total).toBe(1);

    const scan = await findCatalogDuplicates(
      db,
      { workspaceId: workspace.id },
      { computeDHash: async () => '0000000000000000', fileExists: () => true },
    );
    expect(scan).toMatchObject({ total: 2, pending: 0, skipped: 0 });
    expect(scan.groups[0]?.keeperId).toBe(styled.id);

    const other = createWorkspaceInDb(db, { name: 'Other' });
    expect(updateCatalogImage(styled.id, { workspaceId: other.id })?.tags).toEqual(['cat']);
    expect(listCatalogCollections(workspace.id).find((c) => c.name === 'Pets')?.imageCount).toBe(0);
    const deleted = deleteWorkspaceFromDb(db, workspace.id, () => {
      db.query('UPDATE catalog_images SET is_deleted = 1 WHERE workspace_id = ?').run(workspace.id);
      return { failed: [] };
    });
    expect(deleted.ok).toBe(true);
  });

  it('lists user styles', () => {
    expect(createSqliteUserStyleStore(db).listUserStyles()).toEqual([]);
  });
});
