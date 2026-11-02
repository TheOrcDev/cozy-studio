import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

import type { Job } from '../../../../packages/shared/src';
import type { WorkerController } from '../worker';

// Hosted job execution (ADR 0012). Persistent Jobs stay the queue truth (ADR 0005). An instance
// leases a job when it enqueues it, renews the lease while the job is queued or running here, and
// keeps itself alive with waitUntil until its queue drains. The every-minute sweeper picks up jobs
// whose lease lapsed, for example because their instance was evicted.

const LEASE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const QUEUED_GRACE_MS = 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_review']);

export interface HostedJobRuntimeOptions {
  database: () => Database;
  worker: WorkerController;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Downloads the files a job reads before it runs on this instance. */
  prepareJob?: (job: Job) => Promise<void>;
  /** Uploads what the queue produced once it drains. */
  afterIdle?: () => Promise<unknown>;
  listRecoverableJobs: () => Job[];
  logger?: (
    level: 'info' | 'warn' | 'error',
    scope: string,
    message: string,
    jobId?: string,
  ) => void;
}

export function createHostedJobRuntime(options: HostedJobRuntimeOptions) {
  const owner = `instance-${randomUUID()}`;
  const owned = new Set<string>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let drain: Promise<void> | null = null;

  const db = () => options.database();
  const expiry = () => new Date(Date.now() + LEASE_MS).toISOString();

  const claim = (jobId: string) =>
    db()
      .query(
        `INSERT INTO job_leases (job_id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE job_leases.owner = ? OR job_leases.expires_at < ?`,
      )
      .run(jobId, owner, expiry(), owner, new Date().toISOString()).changes === 1;

  const release = (jobId: string) => {
    owned.delete(jobId);
    db().query('DELETE FROM job_leases WHERE job_id = ? AND owner = ?').run(jobId, owner);
  };

  const beat = () => {
    for (const jobId of [...owned]) {
      const row = db().query('SELECT status FROM jobs WHERE id = ?').get(jobId) as {
        status: string;
      } | null;
      const tracked = options.worker.trackedJobIds?.().includes(jobId) ?? false;
      if (!row || TERMINAL.has(row.status)) {
        // Cancelled from another instance: stop the local run as well.
        if (tracked && row && row.status !== 'completed') {
          options.worker.cancelQueuedOrRunningJob(jobId);
        }
        release(jobId);
        continue;
      }
      if (!tracked) {
        release(jobId);
        continue;
      }
      db()
        .query('UPDATE job_leases SET expires_at = ? WHERE job_id = ? AND owner = ?')
        .run(expiry(), jobId, owner);
    }
  };

  const keepAlive = () => {
    if (drain) return;
    heartbeat = setInterval(() => {
      try {
        beat();
      } catch (error) {
        options.logger?.('warn', 'hosted', `Lease heartbeat failed: ${String(error)}`);
      }
    }, HEARTBEAT_MS);
    drain = (async () => {
      try {
        await (options.worker.whenIdle?.() ?? Promise.resolve());
        await options.afterIdle?.();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        for (const jobId of [...owned]) release(jobId);
        drain = null;
      }
    })();
    options.waitUntil(drain);
  };

  const enqueue = (job: Job) => {
    if (!claim(job.id)) return false;
    owned.add(job.id);
    const run = (async () => {
      try {
        await options.prepareJob?.(job);
      } catch (error) {
        options.logger?.('warn', 'hosted', `Preparing job files failed: ${String(error)}`, job.id);
      }
      options.worker.enqueueJob(job);
      keepAlive();
    })();
    options.waitUntil(run);
    return true;
  };

  /** Wraps the worker so every enqueue leases the job and keeps this instance alive. */
  const worker: WorkerController = {
    ...options.worker,
    enqueueJob(job) {
      enqueue(job);
    },
  };

  /** Called by the schedule trigger: adopt queued or running jobs nobody holds a lease for. */
  const sweep = () => {
    const nowIso = new Date().toISOString();
    const leased = new Set(
      (
        db().query('SELECT job_id FROM job_leases WHERE expires_at >= ?').all(nowIso) as Array<{
          job_id: string;
        }>
      ).map((row) => row.job_id),
    );
    let adopted = 0;
    for (const job of options.listRecoverableJobs()) {
      if (leased.has(job.id)) continue;
      const age = Date.now() - Date.parse(job.updatedAt);
      if (job.status === 'queued' && age < QUEUED_GRACE_MS) continue;
      if (enqueue(job)) adopted += 1;
    }
    db().query('DELETE FROM job_leases WHERE expires_at < ?').run(nowIso);
    if (adopted > 0) options.logger?.('info', 'hosted', `Sweeper adopted ${adopted} job(s).`);
    return { adopted };
  };

  return { owner, worker, sweep };
}
