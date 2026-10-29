#!/usr/bin/env node
/**
 * Inspect the memory store on disk without starting DSH.
 *
 *   node scripts/inspect.mjs
 *   node scripts/inspect.mjs --json
 *   MEMORY_TREE_DATA_DIR=/path/to/data node scripts/inspect.mjs
 *
 * Prints the tier files, row counts, spaces, the newest documents and the
 * Markdown mirror count. Read-only: it never writes to the database.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolveConfig } from '../src/engine/config.mjs';

const asJson = process.argv.includes('--json');
const config = resolveConfig({
  dataDir: process.env.MEMORY_TREE_DATA_DIR || '',
  logging: { level: 'error' },
});
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const tiers = [
  ['hot', config.dbPath],
  ['warm', config.storage.warmFile],
  ['cold', config.storage.coldFile],
];

const report = { dataDir: config.dataDir, mirrorDir: config.mirror.dir, tiers: [], totals: {} };

for (const [tier, path] of tiers) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    continue;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.c ?? 0);
  const entry = {
    tier,
    path,
    sizeBytes: size,
    documents: count('SELECT COUNT(*) AS c FROM documents'),
    nodes: count('SELECT COUNT(*) AS c FROM nodes'),
    vectors: count('SELECT COUNT(*) AS c FROM vectors'),
    pending: count("SELECT COUNT(*) AS c FROM documents WHERE status != 'ready'"),
    spaces: db.prepare('SELECT key FROM spaces').all().map((row) => row.key),
    newest: db
      .prepare('SELECT id, title, created_at, status FROM documents ORDER BY id DESC LIMIT 5')
      .all()
      .map((row) => ({ id: Number(row.id), title: row.title, createdAt: row.created_at, status: row.status })),
  };
  report.tiers.push(entry);
  for (const key of ['documents', 'nodes', 'vectors', 'pending', 'sizeBytes']) {
    report.totals[key] = (report.totals[key] ?? 0) + Number(entry[key]);
  }
  db.close();
}

try {
  report.mirrorFiles = readdirSync(config.mirror.dir, { recursive: true })
    .filter((name) => String(name).endsWith('.md')).length;
} catch {
  report.mirrorFiles = 0;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`data dir : ${report.dataDir}`);
  console.log(`mirror   : ${report.mirrorDir} (${report.mirrorFiles} files)`);
  console.log(`totals   : ${report.totals.documents} docs · ${report.totals.nodes} nodes · ${report.totals.vectors} vectors · ${report.totals.pending} pending`);
  for (const tier of report.tiers) {
    console.log(
      `  [${tier.tier}] ${(tier.sizeBytes / 1024).toFixed(1)} KB · ${tier.documents} docs · ${tier.nodes} nodes · ${tier.vectors} vectors · spaces: ${tier.spaces.join(', ') || '-'}`,
    );
    for (const doc of tier.newest) {
      console.log(`      #${doc.id} [${doc.status}] ${doc.createdAt} ${doc.title}`);
    }
  }
  if (report.tiers.length === 0) {
    console.log('  (no tier files yet — the plugin has not captured anything)');
  }
}
