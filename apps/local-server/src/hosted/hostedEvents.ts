import type { Database } from 'bun:sqlite';

import type { StudioEvent, UnknownStudioEvent } from '../../../../packages/shared/src';
import type { StudioEventSink } from '../events';

// Hosted instances share one event order (ADR 0013). publishEvent appends to studio_events, and
// each instance with an open /api/events stream polls that table, so a job finishing in one
// instance reaches a browser connected to another. Revisions become durable and global, which
// keeps ADR 0004's reconnect rules: a stale `since` still reports reconciled: false.

type Listener = (event: StudioEvent | UnknownStudioEvent) => void;

const POLL_INTERVAL_MS = 1_000;
const POLL_BATCH = 200;
const RETENTION_MS = 60 * 60 * 1000;

export function createHostedEventSink(database: () => Database): StudioEventSink {
  return {
    append({ type, payload, createdAt }) {
      const row = database()
        .query(
          'INSERT INTO studio_events (type, payload, created_at) VALUES (?, ?, ?) RETURNING revision',
        )
        .get(type, JSON.stringify(payload ?? null), createdAt) as { revision: number };
      return Number(row.revision);
    },
    currentRevision() {
      const row = database().query('SELECT MAX(revision) AS revision FROM studio_events').get() as {
        revision: number | null;
      };
      return Number(row?.revision ?? 0);
    },
  };
}

export function createHostedEventFeed(database: () => Database, sink: StudioEventSink) {
  const listeners = new Set<Listener>();
  let lastRevision = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    let rows: Array<{ revision: number; type: string; payload: string; created_at: string }>;
    try {
      rows = database()
        .query(
          `SELECT revision, type, payload, created_at FROM studio_events
           WHERE revision > ? ORDER BY revision ASC LIMIT ${POLL_BATCH}`,
        )
        .all(lastRevision) as typeof rows;
    } catch {
      return;
    }
    for (const row of rows) {
      lastRevision = Number(row.revision);
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // Keep delivering the revision even if one payload cannot be read.
      }
      const event = {
        type: row.type,
        payload,
        createdAt: row.created_at,
        revision: lastRevision,
      } as StudioEvent | UnknownStudioEvent;
      for (const listener of listeners) listener(event);
    }
  };

  return {
    subscribe(listener: Listener) {
      if (listeners.size === 0) {
        lastRevision = sink.currentRevision();
        timer = setInterval(poll, POLL_INTERVAL_MS);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
        return true;
      };
    },
  };
}

export function pruneHostedEvents(database: Database, now = Date.now()) {
  database
    .query('DELETE FROM studio_events WHERE created_at < ?')
    .run(new Date(now - RETENTION_MS).toISOString());
}
