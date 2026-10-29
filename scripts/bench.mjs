#!/usr/bin/env node
/**
 * Recall benchmark: how latency and file size scale with the number of memory
 * nodes, and what tiering buys you.
 *
 *   node scripts/bench.mjs                 # 1k / 10k / 30k nodes, fake embedder
 *   node scripts/bench.mjs --sizes 500,5000
 *   node scripts/bench.mjs --dims 1024 --queries 25 --json
 *
 * The fake embedder keeps the benchmark offline and deterministic, so the
 * numbers measure the storage + retrieval path (SQLite, cosine scan, ranking)
 * rather than network latency.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryEngine } from '../src/engine/engine.mjs';
import { resolveConfig } from '../src/engine/config.mjs';

const flags = parseFlags(process.argv.slice(2));
const sizes = String(flags.sizes ?? '1000,10000,30000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const dims = Number(flags.dims ?? 1024);
const queryCount = Number(flags.queries ?? 20);
const asJson = Boolean(flags.json);

const TOPICS = [
  ['光遗传学', '衣藻视蛋白在蓝光下的构象变化与神经调控应用', '生物显示与慢交互艺术装置'],
  ['前端架构', '软决策树AST与分段embedding的版本管理', '编辑器中的模糊语义定位'],
  ['本地推理', '量化模型在消费级显卡上的吞吐与显存权衡', 'LoRA适配器版本回滚'],
  ['认知科学', '阅读眼动与视知觉机制对排版的影响', 'XR交互范式先于原理研究'],
  ['记忆系统', '分层记忆的检索与压缩策略', '跨会话召回的排序与去重'],
  ['存储引擎', 'SQLite WAL与单文件的边界', '向量扫描与近似索引的取舍'],
];

const results = [];

for (const target of sizes) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-memory-bench-${target}-`));
  const config = resolveConfig({
    dataDir: dir,
    logging: { level: process.env.MEMTREE_PROFILE ? 'warn' : 'error' },
    embedding: { fake: true, dimensions: dims },
    capture: { enabled: false },
    recall: { autoInject: false },
    storage: { tiered: true, rotateOnOpen: false, hotDays: 30, warmDays: 180, vacuumAfterRotate: true },
    mirror: { enabled: false },
  });
  const engine = createMemoryEngine(config);

  const startedIndex = performance.now();
  let docs = 0;
  let nodes = 0;
  while (nodes < target) {
    const topic = TOPICS[docs % TOPICS.length];
    const variant = Math.floor(docs / TOPICS.length);
    const ageDays = Math.floor((docs * 37) % 730);
    const createdAt = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    const text = [
      `# ${topic[0]} 笔记 ${docs}`,
      '',
      `## 观察`,
      `${topic[1]}（第 ${variant + 1} 次记录，age=${ageDays}d）`,
      '',
      `## 方案`,
      `${topic[2]}，编号 ${docs}，关键词 ${topic[0]}-${docs}`,
      '',
      `## 结论`,
      `结论 ${docs}: ${topic[0]} 与 ${TOPICS[(docs + 2) % TOPICS.length][0]} 存在交叉点。`,
      '',
    ].join('\n');
    const result = await engine.remember({
      text,
      title: `${topic[0]}-${docs}`,
      cwd: dir,
      source: 'bench',
      createdAt,
    });
    docs += 1;
    nodes += result.nodeCount ?? 0;
  }
  const indexMs = performance.now() - startedIndex;

  const queries = [];
  for (let i = 0; i < queryCount; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    queries.push(`${topic[0]} 的${i % 2 === 0 ? '方案' : '结论'} ${i * 13}`);
  }
  // Warm the statement cache before timing.
  await engine.recall({ query: queries[0], cwd: dir, limit: 6 });

  const samples = [];
  for (const query of queries) {
    const start = performance.now();
    await engine.recall({ query, cwd: dir, limit: 6 });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const stats = engine.stats();
  const hotSize = stats.tiers.find((tier) => tier.tier === 'hot')?.sizeBytes ?? 0;

  // Rotate until no tier has anything left to move, then compact once (VACUUM
  // per pass would dominate the measurement and is not how the plugin runs).
  const rotationStart = performance.now();
  let rotated = 0;
  for (let pass = 0; pass < 40; pass += 1) {
    const result = await engine.rotate({ now: Date.now(), vacuum: false });
    const movedNow = result.moved.reduce((sum, hop) => sum + (hop.documents ?? 0), 0);
    rotated += movedNow;
    if (movedNow === 0) break;
  }
  const rotateMs = performance.now() - rotationStart;
  const compactStart = performance.now();
  engine.compact();
  const compactMs = performance.now() - compactStart;
  const afterRotation = engine.stats();
  const hotAfter = afterRotation.tiers.find((tier) => tier.tier === 'hot')?.sizeBytes ?? 0;
  const totalAfter = afterRotation.totals.sizeBytes;
  const tierDocs = Object.fromEntries(afterRotation.tiers.map((tier) => [tier.tier, tier.documents]));

  // Warm every tier's vector cache, then time cross-tier recall.
  const coldQuery = `${TOPICS[0][0]} 结论 0`;
  for (let i = 0; i < 3; i += 1) await engine.recall({ query: coldQuery, cwd: dir, limit: 3 });
  const coldSamples = [];
  let coldHits = 0;
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    const cold = await engine.recall({ query: coldQuery, cwd: dir, limit: 6 });
    coldSamples.push(performance.now() - start);
    coldHits += cold.results.filter((result) => result.tier !== 'hot').length;
  }
  coldSamples.sort((a, b) => a - b);

  results.push({
    nodes: stats.totals.nodes,
    documents: stats.totals.documents,
    dims,
    indexMs: Math.round(indexMs),
    recallP50Ms: round(samples[Math.floor(samples.length * 0.5)]),
    recallP95Ms: round(samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1]),
    sizeMB: round(stats.totals.sizeBytes / 1048576, 2),
    hotSizeMB: round(hotSize / 1048576, 2),
    rotated,
    rotateMs: Math.round(rotateMs),
    compactMs: Math.round(compactMs),
    hotAfterMB: round(hotAfter / 1048576, 2),
    totalAfterMB: round(totalAfter / 1048576, 2),
    tierDocs,
    crossTierP50Ms: round(coldSamples[Math.floor(coldSamples.length / 2)]),
    crossTierHits: coldHits,
  });

  engine.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best effort on Windows
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n| nodes | docs | DB size | hot size | recall p50 | recall p95 | rotate | hot after | total after | tiers after | cross-tier p50 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of results) {
    const tiers = Object.entries(row.tierDocs)
      .map(([tier, docs]) => `${tier}:${docs}`)
      .join(' ');
    console.log(
      `| ${row.nodes} | ${row.documents} | ${row.sizeMB} MB | ${row.hotSizeMB} MB | ${row.recallP50Ms} ms | ${row.recallP95Ms} ms | ${row.rotated} docs (${row.rotateMs} ms + ${row.compactMs} ms compact) | ${row.hotAfterMB} MB | ${row.totalAfterMB} MB | ${tiers} | ${row.crossTierP50Ms} ms |`,
    );
  }
  console.log(`\nfake embedder, ${dims} dims, ${queryCount} queries per size, node ${process.version}`);
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function parseFlags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}
