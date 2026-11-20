/**
 * Cross-process operation mutex. A separate SQLite transaction coordinates the
 * adapters without holding a transaction on the memory databases during HTTP.
 * The OS releases it even after SIGKILL; no stale PID files or daemon required.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requireNodeSqlite } from '../engine/store.mjs';

export function createOperationLock(dbPath) {
  let db;
  return {
    async acquire({ deadline = Date.now() + 60_000, signal } = {}) {
      if (!db) {
        mkdirSync(dirname(dbPath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        db = new DatabaseSync(`${dbPath}.lock.db`);
        db.exec('PRAGMA busy_timeout = 0');
      }
      for (;;) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('Memory operation timed out waiting for the database');
        try {
          db.exec('BEGIN IMMEDIATE');
          let released = false;
          return () => {
            if (released) return;
            released = true;
            db.exec('ROLLBACK');
          };
        } catch (error) {
          if (error.errcode !== 5 && error.errcode !== 6) throw error;
          await delay(Math.min(30, Math.max(1, deadline - Date.now())), undefined, { signal });
        }
      }
    },
    close() { db?.close(); db = undefined; },
  };
}
