import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

// Hosted mode keeps the synchronous store API that local SQLite has (ADR 0013). The Postgres
// driver is asynchronous, so it runs in a worker thread and the caller blocks on Atomics.wait
// until the reply arrives. One worker owns one connection, which keeps transactions on a single
// session exactly like the single bun:sqlite handle.

export type SyncPostgresDriver =
  | { kind: 'pg'; connectionString: string }
  | { kind: 'pglite'; dataDir?: string };

export interface SyncPostgresResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class SyncPostgresError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SyncPostgresError';
    this.code = code;
  }
}

export interface SyncPostgresClient {
  query(sql: string, params?: readonly unknown[]): SyncPostgresResult;
  close(): void;
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

// Plain CommonJS so the worker survives bundling: the driver is loaded from the resolved path.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let ready;
async function open() {
  const driver = await import(workerData.driverUrl);
  if (workerData.driver.kind === 'pg') {
    const pg = driver.default ?? driver;
    pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
    pg.types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
    const client = new pg.Client({ connectionString: workerData.driver.connectionString });
    await client.connect();
    return {
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
      },
    };
  }
  const { PGlite, types } = driver;
  const db = new PGlite(workerData.driver.dataDir, {
    parsers: { [types.INT8]: (value) => (value === null ? null : Number(value)) },
  });
  await db.waitReady;
  return {
    query: async (sql, params) => {
      const result = await db.query(sql, params);
      return { rows: result.rows ?? [], rowCount: result.affectedRows ?? 0 };
    },
  };
}
ready = open();
parentPort.on('message', async ({ sql, params, state, port }) => {
  const flag = new Int32Array(state);
  try {
    const connection = await ready;
    const result = await connection.query(sql, params);
    port.postMessage({ ok: true, rows: result.rows, rowCount: result.rowCount });
  } catch (error) {
    port.postMessage({
      ok: false,
      message: error && error.message ? String(error.message) : String(error),
      code: error && error.code ? String(error.code) : undefined,
    });
  } finally {
    port.close();
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
});
`;

function resolveDriverUrl(driver: SyncPostgresDriver) {
  const require = createRequire(import.meta.url);
  const specifier = driver.kind === 'pg' ? 'pg' : '@electric-sql/pglite';
  return pathToFileURL(require.resolve(specifier)).href;
}

export function createSyncPostgresClient(
  driver: SyncPostgresDriver,
  options: { queryTimeoutMs?: number } = {},
): SyncPostgresClient {
  const timeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { driver, driverUrl: resolveDriverUrl(driver) },
  });
  // The worker must not keep a finished process alive.
  worker.unref();
  let closed = false;

  return {
    query(sql, params = []) {
      if (closed) throw new SyncPostgresError('Postgres connection is closed.');
      const state = new SharedArrayBuffer(4);
      const flag = new Int32Array(state);
      const { port1, port2 } = new MessageChannel();
      worker.postMessage({ sql, params, state, port: port2 }, [port2]);
      const waited = Atomics.wait(flag, 0, 0, timeoutMs);
      const reply = receiveMessageOnPort(port1)?.message as
        | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
        | { ok: false; message: string; code?: string }
        | undefined;
      port1.close();
      if (!reply) {
        throw new SyncPostgresError(
          waited === 'timed-out'
            ? `Postgres query timed out after ${timeoutMs} ms.`
            : 'Postgres worker returned no reply.',
        );
      }
      if (!reply.ok) throw new SyncPostgresError(reply.message, reply.code);
      return { rows: reply.rows, rowCount: reply.rowCount };
    },
    close() {
      if (closed) return;
      closed = true;
      void worker.terminate();
    },
  };
}
