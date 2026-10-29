#!/usr/bin/env node
/**
 * Small CLI for the memory engine — index notes, query them, inspect the store.
 * Uses the same configuration and database as the DSH plugin, so anything
 * indexed here is immediately recallable inside the harness.
 *
 * Usage:
 *   node scripts/demo.mjs index ./notes            # index a file or directory
 *   node scripts/demo.mjs index ./notes --scope global
 *   node scripts/demo.mjs recall "光遗传学 艺术装置" --limit 5
 *   node scripts/demo.mjs recall "query" --json
 *   node scripts/demo.mjs stats
 *   node scripts/demo.mjs dream
 *
 * Environment:
 *   MEMORY_TREE_DATA_DIR     override the data directory
 *   MEMORY_TREE_EMBED_PRESET pollinations | dashscope | openai | ollama
 *   MEMORY_TREE_API_KEY      embedding key (or write <dataDir>/credentials.json)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMemoryEngine } from '../src/engine/engine.mjs';
import { resolveConfig } from '../src/engine/config.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const args = rest.filter((arg) => !arg.startsWith('--'));

const config = resolveConfig({
  dataDir: process.env.MEMORY_TREE_DATA_DIR || '',
  logging: { level: process.env.MEMORY_TREE_LOG_LEVEL || 'warn' },
  embedding: {
    preset: process.env.MEMORY_TREE_EMBED_PRESET || undefined,
    model: process.env.MEMORY_TREE_EMBED_MODEL || undefined,
    dimensions: process.env.MEMORY_TREE_EMBED_DIM ? Number(process.env.MEMORY_TREE_EMBED_DIM) : undefined,
    fake: process.env.MEMORY_TREE_FAKE_EMBED === '1',
  },
  capture: { enabled: false },
  recall: { autoInject: false },
});

const engine = createMemoryEngine(config);

try {
  switch (command) {
    case 'index': {
      const target = args[0];
      if (!target) usage();
      const files = collect(resolve(target), resolve(config.mirror.dir));
      if (files.length === 0) {
        console.error(`no .md/.txt files under ${target}`);
        process.exit(1);
      }
      let total = 0;
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const result = await engine.remember({
          text,
          title: file.split(/[\\/]/).pop().replace(/\.(md|txt)$/i, ''),
          cwd: process.cwd(),
          scope: flags.scope === 'global' ? 'global' : 'project',
          source: 'file',
          externalId: file,
          importance: flags.importance ? Number(flags.importance) : 0.6,
        });
        total += 1;
        console.log(
          `${result.deduped ? 'skip (duplicate)' : 'indexed'} ${file} → ${result.nodeCount ?? 0} nodes (${result.space.key})`,
        );
      }
      console.log(`\n${total} file(s) processed.`);
      break;
    }
    case 'recall': {
      const query = args.join(' ').trim();
      if (!query) usage();
      const result = await engine.recall({
        query,
        cwd: process.cwd(),
        limit: flags.limit ? Number(flags.limit) : undefined,
        scope: flags.scope === 'global' ? 'global' : undefined,
      });
      if (flags.json) {
        console.log(JSON.stringify(result.results, null, 2));
      } else {
        console.log(result.block || result.text);
      }
      break;
    }
    case 'stats': {
      const stats = engine.stats();
      if (flags.json) console.log(JSON.stringify(stats, null, 2));
      else {
        console.log(`db: ${stats.dbPath} (tiered: ${stats.tiered})`);
        console.log(`embedding: ${stats.embedding.model} (${stats.embedding.dimensions}d) via ${stats.embedding.provider}`);
        console.log(
          `totals: docs=${stats.totals.documents} nodes=${stats.totals.nodes} pending=${stats.totals.pending} size=${(stats.totals.sizeBytes / 1024).toFixed(1)} KB`,
        );
        for (const tier of stats.tiers) {
          console.log(
            `  [${tier.tier}] docs=${tier.documents} nodes=${tier.nodes} size=${(tier.sizeBytes / 1024).toFixed(1)} KB ${tier.dbPath}`,
          );
        }
        for (const space of stats.spaces) {
          console.log(`    ${space.tier}/${space.key} · docs=${space.documents} nodes=${space.nodes}`);
        }
        console.log(`mirror: ${stats.mirrorDir}`);
      }
      break;
    }
    case 'rotate': {
      const result = await engine.rotate({ reason: 'cli' });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'dream': {
      const result = await engine.dream({ cwd: process.cwd(), scope: flags.scope });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'retry': {
      const result = await engine.flushPending();
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      usage();
  }
} finally {
  engine.close();
}

function parseFlags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const nextArg = argv[index + 1];
    if (nextArg && !nextArg.startsWith('--')) {
      out[key] = nextArg;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function collect(target, skipDir = '') {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return /\.(md|txt|markdown)$/i.test(target) ? [target] : [];
  const files = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      // Never re-ingest the memory mirror that lives inside the target tree.
      if (skipDir && resolve(path).toLowerCase() === skipDir.toLowerCase()) continue;
      files.push(...collect(path, skipDir));
    } else if (/\.(md|txt|markdown)$/i.test(entry.name)) files.push(path);
  }
  return files;
}

function usage() {
  console.error(
    [
      'usage:',
      '  node scripts/demo.mjs index <file|dir> [--scope global] [--importance 0.7]',
      '  node scripts/demo.mjs recall "<query>" [--limit 5] [--scope global] [--json]',
      '  node scripts/demo.mjs stats [--json]',
      '  node scripts/demo.mjs dream [--scope project|global|project+global]',
      '  node scripts/demo.mjs retry',
    ].join('\n'),
  );
  process.exit(1);
}
