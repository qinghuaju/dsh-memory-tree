/**
 * SQLite persistence for the memory tree (Node's built-in `node:sqlite`).
 *
 * Design notes:
 * - One single-file database, WAL mode, zero external services → portable.
 * - Vectors are stored as float32 BLOBs (normalized) and searched with a
 *   cosine scan in JS. At the scale this phase targets (tens of thousands of
 *   nodes) this is fast and dependency-free; `sqlite-vec` can be added later
 *   behind the same accessors.
 * - The audit table is append-only and never rewritten by consolidation.
 *
 * @module dsh-memory-tree/engine/store
 */

import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createLogger } from './log.mjs';
import { likePattern } from './ast.mjs';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  root       TEXT,
  kind       TEXT NOT NULL DEFAULT 'project',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  space_id    INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  external_id TEXT,
  session_id  TEXT,
  title       TEXT,
  hash        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  role        TEXT,
  tags        TEXT,
  importance  REAL NOT NULL DEFAULT 0.5,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_space_hash ON documents(space_id, hash);
CREATE INDEX IF NOT EXISTS documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS documents_created ON documents(created_at);

CREATE TABLE IF NOT EXISTS nodes (
  id           INTEGER PRIMARY KEY,
  doc_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id     INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  parent_path  TEXT,
  depth        INTEGER NOT NULL DEFAULT 0,
  ordinal      INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  hash         TEXT NOT NULL,
  importance   REAL NOT NULL DEFAULT 0.5,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access  TEXT,
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_space ON nodes(space_id);
CREATE INDEX IF NOT EXISTS nodes_doc ON nodes(doc_id);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(space_id, path);
CREATE INDEX IF NOT EXISTS nodes_hash ON nodes(space_id, hash);

CREATE TABLE IF NOT EXISTS vectors (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  model   TEXT NOT NULL,
  dim     INTEGER NOT NULL,
  norm    REAL NOT NULL,
  vec     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  src        INTEGER NOT NULL,
  dst        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src, kind);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, kind);

CREATE TABLE IF NOT EXISTS embed_cache (
  key        TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS embed_cache_created ON embed_cache(created_at);

CREATE TABLE IF NOT EXISTS recalls (
  id         INTEGER PRIMARY KEY,
  session_id TEXT,
  space_id   INTEGER,
  query      TEXT NOT NULL,
  node_ids   TEXT NOT NULL,
  scores     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);

-- Lexical index: contentless FTS5 over a pre-tokenized text column. Chinese is
-- split into unigrams + bigrams because unicode61 would treat a whole CJK run
-- as one token.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(fts_text, content='', contentless_delete=1);
`;

const nowIso = () => new Date().toISOString();

/**
 * Build the FTS text for one node: latin words plus CJK bigrams (single
 * characters for one-character runs). `unicode61` cannot segment Chinese, so
 * segmentation happens here and queries are tokenized the same way.
 */
export function tokenizeForFts(text) {
  const lower = String(text ?? '').toLowerCase().slice(0, 4000);
  const parts = [];
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_+#.-]{0,}/g)) {
    if (match[0].length >= 2) parts.push(match[0]);
  }
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) {
      parts.push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) parts.push(run.slice(index, index + 2));
  }
  return parts.join(' ');
}

/** sha256 hex of a string. */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

/** Serialize a vector into a float32 BLOB plus its L2 norm. */
export function packVector(vec) {
  const array = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  let norm = 0;
  for (let i = 0; i < array.length; i += 1) norm += array[i] * array[i];
  norm = Math.sqrt(norm) || 1;
  const normalized = new Float32Array(array.length);
  for (let i = 0; i < array.length; i += 1) normalized[i] = array[i] / norm;
  const bytes = new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  return { blob: new Uint8Array(bytes), dim: normalized.length, norm };
}

/** Deserialize a BLOB back into a Float32Array (copied, alignment-safe). */
export function unpackVector(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** Cosine similarity for normalized vectors (plain dot product). */
export function cosine(a, b, normA = 1, normB = 1) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot / (normA * normB || 1);
}

/**
 * Thin, synchronous data-access layer. All methods are cheap; embedding and
 * file work live in the engine so the plugin never blocks on I/O it can defer.
 */
export class MemoryStore {
  /**
   * @param {{ dbPath: string, tier?: 'hot'|'warm'|'cold'|'single', logger?: object }} options
   */
  constructor({ dbPath, tier = 'single', logger }) {
    this.dbPath = dbPath;
    this.tier = tier;
    this.logger = logger ?? createLogger({ level: 'warn' });
    /** @type {import('node:sqlite').DatabaseSync | null} */
    this.db = null;
    this._spaceCache = new Map();
  }

  open() {
    if (this.db) return this;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    // Loaded lazily so a Node without node:sqlite fails with a clear message.
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.setMeta('tier', this.tier);
    this.ensureFts();
    return this;
  }

  migrate() {
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (!row) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    } else if (Number(row.value) > SCHEMA_VERSION) {
      this.logger.warn?.(
        `memory.db schema ${row.value} is newer than this plugin (${SCHEMA_VERSION}); continuing read/write best effort`,
      );
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (error) {
      this.logger.warn?.('failed to close memory.db', error?.message ?? error);
    }
    this.db = null;
    this._spaceCache.clear();
  }

  /** Run a function inside a transaction. */
  transaction(fn) {
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    }
  }

  requireDb() {
    if (!this.db) this.open();
    return this.db;
  }

  /* ---------------------------------------------------------------- spaces */

  ensureSpace({ key, name, root = '', kind = 'project' }) {
    const db = this.requireDb();
    const existing = db.prepare('SELECT * FROM spaces WHERE key = ?').get(key);
    if (existing) return this.toSpace(existing);
    db.prepare('INSERT INTO spaces (key, name, root, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(
      key,
      name || key,
      root,
      kind,
      nowIso(),
    );
    const row = db.prepare('SELECT * FROM spaces WHERE key = ?').get(key);
    return this.toSpace(row);
  }

  toSpace(row) {
    return {
      id: Number(row.id),
      key: String(row.key),
      name: String(row.name),
      root: row.root ?? '',
      kind: String(row.kind),
    };
  }

  getSpaceByKey(key) {
    const row = this.requireDb().prepare('SELECT * FROM spaces WHERE key = ?').get(key);
    return row ? this.toSpace(row) : null;
  }

  getSpaceById(id) {
    const row = this.requireDb().prepare('SELECT * FROM spaces WHERE id = ?').get(id);
    return row ? this.toSpace(row) : null;
  }

  /** Whether this tier's database file exists on disk (read paths never create it). */
  exists() {
    try {
      return statSync(this.dbPath).isFile();
    } catch {
      return false;
    }
  }

  listSpaces() {
    return this.requireDb()
      .prepare('SELECT * FROM spaces ORDER BY id')
      .all()
      .map((row) => this.toSpace(row));
  }

  /* ------------------------------------------------------------- documents */

  /**
   * Insert a document; returns the existing row when (space, hash) already
   * exists (content-level dedupe), with `deduped: true`.
   */
  insertDocument(doc) {
    const db = this.requireDb();
    const existing = db
      .prepare('SELECT * FROM documents WHERE space_id = ? AND hash = ?')
      .get(doc.spaceId, doc.hash);
    if (existing) return { id: Number(existing.id), deduped: true, status: existing.status };

    const createdAt = doc.createdAt ?? nowIso();
    db.prepare(
      `INSERT INTO documents
        (space_id, source, external_id, session_id, title, hash, text, role, tags, importance, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      doc.spaceId,
      doc.source ?? 'manual',
      doc.externalId ?? null,
      doc.sessionId ?? null,
      doc.title ?? '',
      doc.hash,
      doc.text ?? '',
      doc.role ?? null,
      JSON.stringify(doc.tags ?? []),
      doc.importance ?? 0.5,
      doc.status ?? 'pending',
      createdAt,
      createdAt,
    );
    const row = db.prepare('SELECT id FROM documents WHERE space_id = ? AND hash = ?').get(doc.spaceId, doc.hash);
    return { id: Number(row.id), deduped: false, status: doc.status ?? 'pending' };
  }

  updateDocumentStatus(id, status, error = null) {
    this.requireDb()
      .prepare('UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, nowIso(), id);
  }

  deleteDocument(id) {
    const ids = this.requireDb()
      .prepare('SELECT id FROM nodes WHERE doc_id = ?')
      .all(id)
      .map((row) => Number(row.id));
    this.deleteFtsForNodes(ids);
    this.requireDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
    this.bumpDataVersion();
  }

  listPendingDocuments(spaceIds = [], limit = 20) {
    const db = this.requireDb();
    if (spaceIds.length > 0) {
      const placeholders = spaceIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT * FROM documents WHERE status IN ('pending','failed') AND space_id IN (${placeholders})
           ORDER BY id LIMIT ?`,
        )
        .all(...spaceIds, limit);
    }
    return db
      .prepare(`SELECT * FROM documents WHERE status IN ('pending','failed') ORDER BY id LIMIT ?`)
      .all(limit);
  }

  getDocument(id) {
    return this.requireDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null;
  }

  /* ----------------------------------------------------------------- nodes */

  insertNodes(spaceId, docId, nodes, { importance = 0.5, createdAt = nowIso() } = {}) {
    const db = this.requireDb();
    const statement = db.prepare(
      `INSERT INTO nodes
        (doc_id, space_id, path, parent_path, depth, ordinal, kind, title, content, hash, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids = [];
    for (const node of nodes) {
      const result = statement.run(
        docId,
        spaceId,
        node.path,
        node.parentPath ?? null,
        node.depth ?? 0,
        node.ordinal ?? 0,
        node.kind,
        node.title,
        node.content,
        node.hash,
        importance,
        createdAt,
        createdAt,
      );
      ids.push(Number(result.lastInsertRowid));
    }
    this.insertFtsForNodes(
      nodes.map((node, index) => ({ id: ids[index], title: node.title, content: node.content })),
    );
    this.bumpDataVersion();
    return ids;
  }

  listNodesByDoc(docId) {
    return this.requireDb()
      .prepare('SELECT * FROM nodes WHERE doc_id = ? ORDER BY ordinal')
      .all(docId);
  }

  deleteNodesByDoc(docId) {
    const ids = this.requireDb()
      .prepare('SELECT id FROM nodes WHERE doc_id = ?')
      .all(docId)
      .map((row) => Number(row.id));
    this.deleteFtsForNodes(ids);
    this.requireDb().prepare('DELETE FROM nodes WHERE doc_id = ?').run(docId);
    this.bumpDataVersion();
  }

  /** Resolve AST paths to node ids inside the given spaces. */
  getNodeIdsByPaths(spaceIds, paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    if (spaceIds.length === 0 || unique.length === 0) return new Map();
    const db = this.requireDb();
    const spacePlaceholders = spaceIds.map(() => '?').join(',');
    const pathPlaceholders = unique.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, path FROM nodes WHERE archived = 0
           AND space_id IN (${spacePlaceholders}) AND path IN (${pathPlaceholders})`,
      )
      .all(...spaceIds, ...unique);
    const map = new Map();
    for (const row of rows) if (!map.has(row.path)) map.set(String(row.path), Number(row.id));
    return map;
  }

  getNodesByIds(ids) {
    const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return new Map();
    const db = this.requireDb();
    const placeholders = list.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...list);
    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  searchNodesByPath(spaceIds, prefix, limit = 50) {
    if (spaceIds.length === 0) return [];
    const db = this.requireDb();
    const placeholders = spaceIds.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT * FROM nodes WHERE archived = 0 AND space_id IN (${placeholders}) AND path LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, ordinal ASC LIMIT ?`,
      )
      .all(...spaceIds, `${String(prefix).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`, limit);
  }

  /** Keyword candidates via SQL LIKE per term (CJK bigrams make this usable). */
  lexicalCandidates(spaceIds, terms, limit = 30) {
    if (spaceIds.length === 0 || terms.length === 0) return [];
    const viaFts = this.ftsCandidates(spaceIds, terms, limit);
    if (viaFts !== null) return viaFts;
    return this.likeCandidates(spaceIds, terms, limit);
  }

  /**
   * FTS5 candidates. Returns null when FTS is unusable (so callers can fall
   * back to LIKE), otherwise { node, weight } sorted best-first.
   */
  ftsCandidates(spaceIds, terms, limit = 30) {
    const db = this.requireDb();
    const clean = terms
      .map((term) => String(term).trim())
      .filter((term) => term.length > 0)
      .slice(0, 12);
    if (clean.length === 0) return [];
    const match = clean.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    let rows;
    try {
      rows = db
        .prepare('SELECT rowid AS id, bm25(nodes_fts) AS rank FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(match, Math.max(limit * 6, 60));
    } catch {
      return null;
    }
    if (rows.length === 0) return [];
    const nodes = this.getNodesByIds(rows.map((row) => Number(row.id)));
    const spaceSet = new Set(spaceIds.map(Number));
    const known = [...nodes.values()];
    const out = [];
    for (const row of rows) {
      const node = nodes.get(Number(row.id));
      if (!node || !spaceSet.has(Number(node.space_id)) || Number(node.archived) === 1) continue;
      const title = String(node.title ?? '').toLowerCase();
      const content = String(node.content ?? '').toLowerCase();
      const hits = clean.reduce(
        (sum, term) => sum + (title.includes(term) || content.includes(term) ? 1 : 0),
        0,
      );
      const bm25 = Math.max(0, -Number(row.rank ?? 0));
      out.push({ node, weight: hits + Math.min(2, bm25 * 0.25) });
    }
    return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
  }

  /** LIKE-based fallback when FTS is unavailable. */
  likeCandidates(spaceIds, terms, limit = 30) {
    if (spaceIds.length === 0 || terms.length === 0) return [];
    const db = this.requireDb();
    const placeholders = spaceIds.map(() => '?').join(',');
    const scored = new Map();
    for (const term of terms.slice(0, 8)) {
      const pattern = likePattern(term);
      const rows = db
        .prepare(
          `SELECT id, title, content FROM nodes
           WHERE archived = 0 AND space_id IN (${placeholders})
             AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
           LIMIT ?`,
        )
        .all(...spaceIds, pattern, pattern, limit);
      for (const row of rows) {
        const id = Number(row.id);
        const entry = scored.get(id) ?? { id, weight: 0 };
        entry.weight += term.length >= 2 ? 2 : 1;
        scored.set(id, entry);
      }
    }
    const weighted = [...scored.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
    const nodes = this.getNodesByIds(weighted.map((entry) => entry.id));
    return weighted
      .map((entry) => ({ node: nodes.get(entry.id), weight: entry.weight }))
      .filter((entry) => entry.node);
  }

  /* ------------------------------------------------------------------ FTS */

  /** Insert FTS rows for node rows: [{ id, title, content }]. */
  insertFtsForNodes(rows) {
    if (rows.length === 0) return 0;
    const statement = this.requireDb().prepare('INSERT INTO nodes_fts (rowid, fts_text) VALUES (?, ?)');
    for (const row of rows) statement.run(Number(row.id), tokenizeForFts(`${row.title ?? ''} ${row.content ?? ''}`));
    return rows.length;
  }

  deleteFtsForNodes(ids) {
    const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return 0;
    const statement = this.requireDb().prepare('DELETE FROM nodes_fts WHERE rowid = ?');
    for (const id of list) {
      try {
        statement.run(id);
      } catch {
        // Contentless tables can miss rows after an external restore; ignore.
      }
    }
    return list.length;
  }

  /** Rebuild the whole FTS index from nodes (used on first open of an old DB). */
  rebuildFts() {
    const db = this.requireDb();
    // Recreate instead of `DELETE FROM`: contentless FTS5 tables do not accept an
    // unqualified DELETE in every SQLite build, and a rebuild is O(rows) anyway.
    db.exec('DROP TABLE IF EXISTS nodes_fts;');
    db.exec("CREATE VIRTUAL TABLE nodes_fts USING fts5(fts_text, content='', contentless_delete=1);");
    const rows = db.prepare('SELECT id, title, content FROM nodes WHERE archived = 0').all();
    this.transaction(() => this.insertFtsForNodes(rows));
    this.setMeta('fts_built', '1');
    return rows.length;
  }

  /** Ensure every node has an FTS row exactly once (cheap count check). */
  ensureFts() {
    try {
      const db = this.requireDb();
      const nodes = Number(db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE archived = 0').get().c);
      if (nodes === 0) return;
      let indexed = -1;
      try {
        indexed = Number(db.prepare('SELECT COUNT(*) AS c FROM nodes_fts').get().c);
      } catch {
        indexed = -1;
      }
      if (indexed !== nodes) this.rebuildFts();
    } catch (error) {
      // A broken lexical index must not stop the plugin: LIKE remains a fallback.
      this.logger.warn?.(`fts index check failed: ${error?.message ?? error}`);
    }
  }

  /* --------------------------------------------------------------- vectors */

  putVector(nodeId, model, vec) {
    const { blob, dim, norm } = packVector(vec);
    this.requireDb()
      .prepare(
        `INSERT INTO vectors (node_id, model, dim, norm, vec) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, norm = excluded.norm, vec = excluded.vec`,
      )
      .run(nodeId, model, dim, norm, blob);
    return { dim, norm };
  }

  /** All vectors for the given spaces (used for the cosine scan). */
  listVectors(spaceIds) {
    if (spaceIds.length === 0) return [];
    const placeholders = spaceIds.map(() => '?').join(',');
    const rows = this.requireDb()
      .prepare(
        `SELECT v.node_id AS nodeId, v.norm AS norm, v.vec AS vec
         FROM vectors v JOIN nodes n ON n.id = v.node_id
         WHERE n.archived = 0 AND n.space_id IN (${placeholders})`,
      )
      .all(...spaceIds);
    return rows.map((row) => ({
      nodeId: Number(row.nodeId),
      norm: Number(row.norm) || 1,
      vec: unpackVector(row.vec),
    }));
  }

  getVectorsByNodeIds(ids) {
    const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return new Map();
    const placeholders = list.map(() => '?').join(',');
    const rows = this.requireDb()
      .prepare(`SELECT node_id AS nodeId, norm, vec FROM vectors WHERE node_id IN (${placeholders})`)
      .all(...list);
    return new Map(rows.map((row) => [Number(row.nodeId), { norm: Number(row.norm) || 1, vec: unpackVector(row.vec) }]));
  }

  countVectors(spaceIds = []) {
    const db = this.requireDb();
    if (spaceIds.length === 0) return Number(db.prepare('SELECT COUNT(*) AS c FROM vectors').get().c);
    const placeholders = spaceIds.map(() => '?').join(',');
    return Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM vectors v JOIN nodes n ON n.id = v.node_id
           WHERE n.space_id IN (${placeholders})`,
        )
        .get(...spaceIds).c,
    );
  }

  /* ----------------------------------------------------------------- edges */

  addEdges(edges) {
    if (edges.length === 0) return 0;
    const db = this.requireDb();
    const statement = db.prepare(
      `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight`,
    );
    const createdAt = nowIso();
    let count = 0;
    for (const edge of edges) {
      statement.run(edge.src, edge.dst, edge.kind, edge.weight, createdAt);
      count += 1;
    }
    return count;
  }

  edgesFor(nodeIds, kinds = ['similar']) {
    const list = [...new Set(nodeIds.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return [];
    const placeholders = list.map(() => '?').join(',');
    const kindPlaceholders = kinds.map(() => '?').join(',');
    return this.requireDb()
      .prepare(
        `SELECT src, dst, kind, weight FROM edges
         WHERE kind IN (${kindPlaceholders}) AND (src IN (${placeholders}) OR dst IN (${placeholders}))`,
      )
      .all(...kinds, ...list, ...list);
  }

  clearEdges(spaceIds = []) {
    const db = this.requireDb();
    if (spaceIds.length === 0) {
      db.prepare('DELETE FROM edges').run();
      return;
    }
    const placeholders = spaceIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM edges WHERE src IN (SELECT id FROM nodes WHERE space_id IN (${placeholders}))
         OR dst IN (SELECT id FROM nodes WHERE space_id IN (${placeholders}))`,
    ).run(...spaceIds, ...spaceIds);
  }

  /* ---------------------------------------------------------------- recall */

  touchNodes(ids, when = nowIso()) {
    if (ids.length === 0) return;
    const db = this.requireDb();
    const statement = db.prepare(
      'UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?',
    );
    for (const id of ids) statement.run(when, id);
  }

  recordRecall({ sessionId, spaceId, query, nodeIds, scores }) {
    this.requireDb()
      .prepare('INSERT INTO recalls (session_id, space_id, query, node_ids, scores, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId ?? null, spaceId ?? null, query, JSON.stringify(nodeIds), JSON.stringify(scores ?? []), nowIso());
  }

  lastRecallFor(sessionId, queryHash, spaceId) {
    if (!sessionId) return null;
    const db = this.requireDb();
    return spaceId === null || spaceId === undefined
      ? db
          .prepare(
            'SELECT * FROM recalls WHERE session_id = ? AND space_id IS NULL AND query LIKE ? ORDER BY id DESC LIMIT 1',
          )
          .get(sessionId, `%${queryHash}%`) ?? null
      : db
          .prepare(
            'SELECT * FROM recalls WHERE session_id = ? AND space_id = ? AND query LIKE ? ORDER BY id DESC LIMIT 1',
          )
          .get(sessionId, spaceId, `%${queryHash}%`) ?? null;
  }

  /* -------------------------------------------------------- embed cache */

  getCachedVector(key) {
    const row = this.requireDb().prepare('SELECT vec, dim FROM embed_cache WHERE key = ?').get(key);
    if (!row) return null;
    return unpackVector(row.vec);
  }

  putCachedVector(key, model, vec) {
    const { blob, dim } = packVector(vec);
    this.requireDb()
      .prepare('INSERT INTO embed_cache (key, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, model, dim, blob, nowIso());
  }

  pruneEmbedCache(maxRows = 5000) {
    const count = Number(this.requireDb().prepare('SELECT COUNT(*) AS c FROM embed_cache').get().c);
    if (count <= maxRows) return 0;
    const excess = count - maxRows;
    this.requireDb()
      .prepare('DELETE FROM embed_cache WHERE key IN (SELECT key FROM embed_cache ORDER BY created_at ASC LIMIT ?)')
      .run(excess);
    return excess;
  }

  /** Keep the recall audit bounded (it is a log, not memory content). */
  pruneRecalls(maxRows = 20_000) {
    const db = this.requireDb();
    const count = Number(db.prepare('SELECT COUNT(*) AS c FROM recalls').get().c);
    if (count <= maxRows) return 0;
    db.prepare('DELETE FROM recalls WHERE id IN (SELECT id FROM recalls ORDER BY id ASC LIMIT ?)').run(count - maxRows);
    return count - maxRows;
  }

  /* ------------------------------------------------------------------ misc */

  audit(action, target, detail) {
    this.requireDb()
      .prepare('INSERT INTO audit (action, target, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(action, target ?? null, detail === undefined ? null : JSON.stringify(detail), nowIso());
  }

  stats(spaces = []) {
    const db = this.requireDb();
    const spaceIds = spaces.map((space) => space.id);
    const where = spaceIds.length > 0 ? `WHERE space_id IN (${spaceIds.map(() => '?').join(',')})` : '';
    const docCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM documents ${where}`).get(...spaceIds).c);
    const nodeCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM nodes ${where}`).get(...spaceIds).c);
    const pendingCount = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM documents ${where ? `${where} AND` : 'WHERE'} status != 'ready'`)
        .get(...spaceIds).c,
    );
    const vectorCount = this.countVectors(spaceIds);
    return { documents: docCount, nodes: nodeCount, vectors: vectorCount, pending: pendingCount };
  }

  listSpaceStats() {
    return this.requireDb()
      .prepare(
        `SELECT s.key AS key, s.name AS name, s.root AS root,
                (SELECT COUNT(*) FROM documents d WHERE d.space_id = s.id) AS documents,
                (SELECT COUNT(*) FROM nodes n WHERE n.space_id = s.id) AS nodes
         FROM spaces s ORDER BY s.id`,
      )
      .all()
      .map((row) => ({
        key: row.key,
        name: row.name,
        root: row.root,
        documents: Number(row.documents),
        nodes: Number(row.nodes),
      }));
  }

  /** Remove exact duplicate nodes inside one space (keeps the oldest). */
  dedupeNodes(spaceId) {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT hash, GROUP_CONCAT(id) AS ids, COUNT(*) AS c FROM nodes
         WHERE space_id = ? GROUP BY hash HAVING c > 1`,
      )
      .all(spaceId);
    let removed = 0;
    const statement = db.prepare('DELETE FROM nodes WHERE id = ?');
    for (const row of rows) {
      const ids = String(row.ids).split(',').map(Number).sort((a, b) => a - b);
      for (const id of ids.slice(1)) {
        this.deleteFtsForNodes([id]);
        statement.run(id);
        removed += 1;
      }
    }
    if (removed > 0) this.bumpDataVersion();
    return removed;
  }
  /* ------------------------------------------------------------ tiering */

  setMeta(key, value) {
    this.requireDb()
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  getMeta(key) {
    const row = this.requireDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }

  /** Monotonic write counter used to invalidate in-process vector caches. */
  dataVersion() {
    return Number(this.getMeta('data_version') ?? 0);
  }

  bumpDataVersion() {
    const current = this.dataVersion();
    this.setMeta('data_version', String(current + 1));
    return current + 1;
  }

  /** Ready documents older than an ISO timestamp (rotation source). */
  listDocumentsBefore(iso, limit = 200) {
    return this.requireDb()
      .prepare("SELECT * FROM documents WHERE status = 'ready' AND created_at < ? ORDER BY created_at ASC LIMIT ?")
      .all(iso, limit);
  }

  /** Vector rows including their model, for cross-file moves. */
  listVectorRecords(nodeIds) {
    const list = [...new Set(nodeIds.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return [];
    const placeholders = list.map(() => '?').join(',');
    return this.requireDb()
      .prepare(`SELECT node_id AS nodeId, model, dim, norm, vec FROM vectors WHERE node_id IN (${placeholders})`)
      .all(...list)
      .map((row) => ({
        nodeId: Number(row.nodeId),
        model: row.model,
        dim: Number(row.dim),
        norm: Number(row.norm),
        vec: unpackVector(row.vec),
      }));
  }

  /** Insert fully-specified node rows (used when moving documents between tiers). */
  insertNodesRaw(spaceId, docId, rows) {
    const db = this.requireDb();
    const statement = db.prepare(
      `INSERT INTO nodes
        (doc_id, space_id, path, parent_path, depth, ordinal, kind, title, content, hash, importance,
         created_at, updated_at, access_count, last_access, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids = [];
    for (const row of rows) {
      const result = statement.run(
        docId,
        spaceId,
        row.path,
        row.parent_path ?? null,
        row.depth ?? 0,
        row.ordinal ?? 0,
        row.kind,
        row.title,
        row.content,
        row.hash,
        row.importance ?? 0.5,
        row.created_at,
        row.updated_at ?? row.created_at,
        row.access_count ?? 0,
        row.last_access ?? null,
        row.archived ?? 0,
      );
      ids.push(Number(result.lastInsertRowid));
    }
    this.insertFtsForNodes(rows.map((row, index) => ({ id: ids[index], title: row.title, content: row.content })));
    this.bumpDataVersion();
    return ids;
  }

  deleteEdgesForNodes(nodeIds) {
    const list = [...new Set(nodeIds.map(Number).filter(Number.isFinite))];
    if (list.length === 0) return 0;
    const placeholders = list.map(() => '?').join(',');
    return this.requireDb()
      .prepare(`DELETE FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`)
      .run(...list, ...list).changes;
  }

  /** Drop stored vectors for nodes older than an ISO timestamp (size control). */
  dropVectorsBefore(iso) {
    const result = this.requireDb()
      .prepare(
        `DELETE FROM vectors WHERE node_id IN (SELECT id FROM nodes WHERE created_at < ?)`,
      )
      .run(iso);
    return Number(result.changes ?? 0);
  }

  /**
   * Reclaim file space after deletions.
   *
   * Inside WAL mode `VACUUM` only rewrites pages through the WAL and leaves the
   * main file at its high-water mark, so the file must be switched to a
   * rollback journal for the rewrite, then back to WAL. A busy file (another
   * process) degrades to a plain VACUUM: logically compact, physically larger.
   */
  compact() {
    const db = this.requireDb();
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // A busy checkpoint is not fatal.
    }
    let wal = true;
    try {
      const mode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase();
      wal = mode === 'wal';
      if (wal) db.exec('PRAGMA journal_mode=DELETE;');
    } catch {
      wal = false;
    }
    try {
      db.exec('VACUUM;');
    } catch (error) {
      this.logger.warn?.(`vacuum failed for ${this.dbPath}: ${error?.message ?? error}`);
      return false;
    } finally {
      if (wal) {
        try {
          db.exec('PRAGMA journal_mode=WAL;');
        } catch (error) {
          this.logger.warn?.(`restoring WAL failed for ${this.dbPath}: ${error?.message ?? error}`);
        }
      }
    }
    return true;
  }

  /** Approximate on-disk footprint of this tier. */
  fileSize() {
    const size = (path) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    const mainBytes = size(this.dbPath);
    const walBytes = size(`${this.dbPath}-wal`);
    return { bytes: mainBytes, mainBytes, walBytes };
  }

  countDocuments(spaceIds = []) {
    const db = this.requireDb();
    if (spaceIds.length === 0) return Number(db.prepare('SELECT COUNT(*) AS c FROM documents').get().c);
    const placeholders = spaceIds.map(() => '?').join(',');
    return Number(
      db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE space_id IN (${placeholders})`).get(...spaceIds).c,
    );
  }

  /** All node ids in this store, optionally bounded (edge rebuild). */
  listNodeIds(limit = 20_000) {
    return this.requireDb()
      .prepare('SELECT id FROM nodes WHERE archived = 0 ORDER BY id LIMIT ?')
      .all(limit)
      .map((row) => Number(row.id));
  }

  /** Most recently inserted node ids in a space (bounded neighbour candidates). */
  listRecentNodeIds(spaceId, limit = 120) {
    return this.requireDb()
      .prepare('SELECT id FROM nodes WHERE space_id = ? AND archived = 0 ORDER BY id DESC LIMIT ?')
      .all(spaceId, limit)
      .map((row) => Number(row.id));
  }
}

const requireBuiltin = createRequire(import.meta.url);

/** Load `node:sqlite`, or throw a helpful error when the runtime is too old. */
export function requireNodeSqlite() {
  try {
    return requireBuiltin('node:sqlite');
  } catch (error) {
    const message =
      'dsh-memory-tree needs Node 22.5+ (node:sqlite). ' +
      `Current runtime: ${process.version}. Start DSH with its bundled Node 24 or upgrade Node. (${error?.message ?? error})`;
    throw new Error(message);
  }
}
