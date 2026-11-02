import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Job } from '../../../../packages/shared/src';
import { setDefaultDb } from '../db/connection';
import { createJob, getJob, listRecoverableJobs } from '../db/jobs';
import { createTestPostgresDatabase } from '../db/postgres/testPostgresDatabase';
import type { WorkerController } from '../worker';
import { createHostedEventFeed, createHostedEventSink, pruneHostedEvents } from './hostedEvents';
import { createHostedJobRuntime } from './hostedJobs';

function fakeWorker() {
  const queued: string[] = [];
  const worker: WorkerController = {
    enqueueJob: (job: Job) => void queued.push(job.id),
    cancelQueuedOrRunningJob: () => null,
    getWorkerStatus: () => ({}) as ReturnType<WorkerController['getWorkerStatus']>,
    resetWorkerState: async () => undefined,
    shutdown: async () => undefined,
    whenIdle: async () => undefined,
    trackedJobIds: () => [...queued],
  };
  return { worker, queued };
}

describe('hosted job leases', () => {
  let database: Database;

  beforeAll(() => {
    database = createTestPostgresDatabase();
    setDefaultDb(database);
  }, 60_000);

  afterAll(() => {
    setDefaultDb(null);
    database?.close();
  });

  it('runs a job on one instance only and adopts it once the lease lapses', async () => {
    const pending: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => void pending.push(promise);
    const first = fakeWorker();
    const second = fakeWorker();
    const runtimeA = createHostedJobRuntime({
      database: () => database,
      worker: first.worker,
      waitUntil,
      listRecoverableJobs,
    });
    const runtimeB = createHostedJobRuntime({
      database: () => database,
      worker: second.worker,
      waitUntil,
      listRecoverableJobs,
    });

    const job = createJob({ kind: 'image_generate', prompt: 'leased', providerId: 'chatgpt' });
    runtimeA.worker.enqueueJob(job);
    runtimeB.worker.enqueueJob(job);
    await Promise.all(pending.splice(0));
    expect(first.queued).toEqual([job.id]);
    expect(second.queued).toEqual([]);

    // Instance A disappears: its lease lapses and the job looks stale to the sweeper.
    database
      .query('UPDATE job_leases SET expires_at = ? WHERE job_id = ?')
      .run('2000-01-01T00:00:00.000Z', job.id);
    database
      .query('UPDATE jobs SET updated_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', job.id);
    expect(runtimeB.sweep().adopted).toBe(1);
    await Promise.all(pending.splice(0));
    expect(second.queued).toEqual([job.id]);
    expect(getJob(job.id)?.status).toBe('queued');
  });
});

describe('hosted events', () => {
  let database: Database;

  beforeAll(() => {
    database = createTestPostgresDatabase();
  }, 60_000);

  afterAll(() => database?.close());

  it('orders events across instances and delivers them to every feed', async () => {
    vi.useFakeTimers();
    try {
      const sinkA = createHostedEventSink(() => database);
      const sinkB = createHostedEventSink(() => database);
      const feed = createHostedEventFeed(() => database, sinkB);
      const received: Array<{ type: string; revision?: number }> = [];
      const unsubscribe = feed.subscribe((event) => received.push(event));

      const first = sinkA.append({
        type: 'job.created',
        payload: { id: 1 },
        createdAt: '2026-01-01T00:00:00Z',
      });
      const second = sinkB.append({
        type: 'job.completed',
        payload: { id: 1 },
        createdAt: '2026-01-01T00:00:01Z',
      });
      expect(second).toBeGreaterThan(first);
      expect(sinkA.currentRevision()).toBe(second);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(received.map((event) => event.type)).toEqual(['job.created', 'job.completed']);
      unsubscribe();

      pruneHostedEvents(database, Date.parse('2026-01-01T02:00:00Z'));
      expect(database.query('SELECT COUNT(*) AS n FROM studio_events').get()).toEqual({ n: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
