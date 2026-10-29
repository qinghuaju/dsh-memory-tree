#!/usr/bin/env node
/**
 * Generate the format-1 plugin-market index for this repository.
 *
 *   node scripts/market-index.mjs --owner <gh-user> --repo dsh-memory-tree --commit <40-hex> [--npm] [--registry https://...]
 *
 * The market validates indexes with @deepseek-ai/dsh-plugin-market-index; this
 * script mirrors the required shape so the file can be published without the
 * DSH packages installed. Run scripts/check-market.mjs afterwards.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const owner = String(arg('owner', '')).trim();
const repo = String(arg('repo', 'dsh-memory-tree')).trim();
const commit = String(arg('commit', '')).trim();
const useNpm = Boolean(arg('npm', false));
const registry = arg('registry', undefined);
const out = String(arg('out', join(ROOT, 'market', 'index.json')));

if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error('usage: node scripts/market-index.mjs --owner <github-user> --commit <40-hex> [--npm] [--registry <url>]');
  process.exit(2);
}
if (!/^[a-f0-9]{40}$/.test(commit)) {
  console.error('--commit must be a lowercase 40-hex commit SHA');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const repoUrl = `https://github.com/${owner}/${repo}`;
const publishTimestamp = Math.floor(Date.now() / 1000);

const source = useNpm
  ? { type: 'npm', ...(registry ? { registry: String(registry) } : {}) }
  : { type: 'git', url: repoUrl, commit, path: '.' };

const index = {
  format: 1,
  title: { en: 'DSH Memory Tree', zh: 'DSH 记忆树' },
  description: {
    en: 'Long-term memory for DeepSeek Harness: AST-indexed, tiered SQLite with embeddings and cross-session recall.',
    zh: '为 DeepSeek Harness 提供长期记忆：AST 索引、分层 SQLite、向量召回，跨会话可继承。',
  },
  metadata: {
    categories: {
      memory: { title: { en: 'Memory', zh: '记忆' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Memory Tree', zh: '记忆树' },
      description: {
        en: 'Captures conversations into an addressable AST, embeds them, tiers the database, and injects a bounded recall block before each turn.',
        zh: '把对话捕获成可寻址的 AST、向量化、分层落盘，并在每轮开始前注入有界的召回块。',
      },
      icon: 'icon.svg',
      author: 'dsh-memory-tree contributors',
      homepage: repoUrl,
      repository: { url: repoUrl, directory: '.' },
      metadata: {
        category: 'memory',
        keywords: pkg.keywords ?? ['dsh', 'memory', 'sqlite', 'embedding'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source,
          engines: { dsh: '>=0.2.1-rc.3' },
        },
      ],
    },
  ],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`market index written: ${out}`);
console.log(`  plugin ${pkg.name}@${pkg.version} via ${source.type}${useNpm ? '' : ` @ ${commit.slice(0, 10)}`}`);
