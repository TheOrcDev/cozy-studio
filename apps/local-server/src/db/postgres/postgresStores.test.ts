import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryCatalog, queryCatalogWorkspaceSummaries, registerCatalogImage } from '../../catalog';
import {
  createCatalogCollection,
  listCatalogCollections,
  updateCatalogCollection,
} from '../../catalogCollections';
import { listCatalogTags, updateCatalogTag } from '../../catalogTags';
import { ensureDefaultLibrary, listLibraries } from '../../libraries';
import type { PreparedPersistentJob } from '../../persistentJobIntake';
import { createSqliteUserStyleStore } from '../../sqliteUserStyles';
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
import { ensureDefaultWorkspace, listWorkspaces } from '../workspaces';
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

  it('lists user styles', () => {
    expect(createSqliteUserStyleStore(db).listUserStyles()).toEqual([]);
  });
});
