/** Durable, redacted Codex capture outbox. It never parses Codex transcripts. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireNodeSqlite, sha256 } from '../engine/store.mjs';
import { redactSecrets } from '../engine/redact.mjs';

export function openCaptureQueue(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(join(config.dataDir, 'codex-capture.db'));
  db.exec(`PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL, prompts TEXT NOT NULL, response TEXT,
      state TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );`);
  const key = event => sha256(JSON.stringify([event.session_id, event.turn_id, event.cwd]));
  const clean = text => redactSecrets(String(text)).text.slice(0, config.capture.maxChars);
  const now = () => new Date().toISOString();

  return {
    prompt(event) {
      const text = clean(event.prompt).trim();
      if (text.length < config.capture.minChars) return;
      const id = key(event);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
        if (!previous) {
          db.prepare('INSERT INTO turns (id,session_id,turn_id,cwd,prompts,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
            .run(id, event.session_id, event.turn_id, event.cwd, JSON.stringify([text]), now(), now());
        } else if (previous.state === 'waiting') {
          const prompts = JSON.parse(previous.prompts);
          if (!prompts.includes(text) && prompts.join('\n').length < config.capture.maxChars) {
            prompts.push(text);
            db.prepare('UPDATE turns SET prompts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prompts), now(), id);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    complete(event) {
      if (config.capture.includeAssistant && typeof event.last_assistant_message !== 'string') return;
      const response = config.capture.includeAssistant ? clean(event.last_assistant_message) : '';
      // The first completed response wins. Duplicate/background Stop delivery is harmless.
      db.prepare("UPDATE turns SET response = ?, state = 'ready', updated_at = ? WHERE id = ? AND state = 'waiting'")
        .run(response, now(), key(event));
    },
    pending(limit = 10) {
      return db.prepare("SELECT * FROM turns WHERE state = 'ready' ORDER BY updated_at LIMIT ?").all(limit)
        .filter(row => !config.capture.excludeSessions.some(needle => needle && (row.session_id.includes(needle) || row.cwd.includes(needle))))
        .map(row => ({ id: row.id, sessionId: `codex:${row.session_id}`, cwd: row.cwd,
          source: 'codex:capture', externalId: row.id, createdAt: row.created_at,
          messages: [...JSON.parse(row.prompts).map(text => ({ role: 'user', text })),
            ...(row.response ? [{ role: 'assistant', text: row.response }] : [])],
        }));
    },
    done(id) {
      // Keep only a receipt; don't retain a second copy of completed conversations.
      db.prepare("UPDATE turns SET state = 'done', prompts = '[]', response = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    },
    failed(id) {
      db.prepare('UPDATE turns SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now(), id);
    },
    prune() {
      db.prepare("DELETE FROM turns WHERE state != 'ready' AND updated_at < ?")
        .run(new Date(Date.now() - 7 * 86_400_000).toISOString());
    },
    close() { db.close(); },
  };
}
