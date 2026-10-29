#!/usr/bin/env node
/**
 * Pre-commit / pre-publish secret scan.
 *
 * Fails when the working tree contains something that looks like a live
 * credential (API key, token, password) or a personal account identifier that
 * must not be published. Ignored paths (node_modules, data/, .env, memory.db)
 * are skipped, and known placeholder patterns in docs are allowed.
 *
 *   node scripts/check-secrets.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
// `local/` and `.local/` hold machine-local downloads and vendor artifacts; they
// are git-ignored, so they must not be able to fail the publish gate.
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'coverage', '.tmp', '.local', 'local', 'acl-recovery']);
const SKIP_FILES = new Set(['credentials.json', 'memory.db']);
const SKIP_EXT = /\.(db|db-wal|db-shm|png|jpg|jpeg|webp|gif|zip|exe|dll|pdf|log)$/i;

/** Patterns that indicate a real secret rather than a placeholder. */
const RULES = [
  { name: 'pollinations secret key', re: /\bsk_[A-Za-z0-9]{16,}\b/g },
  { name: 'pollinations publishable key', re: /\bpk_[A-Za-z0-9]{16,}\b/g },
  { name: 'openai-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g },
  { name: 'github token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'hardcoded password', re: /\b(?:password|passwd|pwd)\s*[:=]\s*['"][^'"\n]{6,}['"]/gi },
  { name: 'hardcoded secret', re: /\b(?:secret|api[_-]?key|auth[_-]?code)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{12,}['"]/gi },
  { name: 'personal email', re: /\b[0-9]{6,}@qq\.com\b/g },
];

/** Lines that are documentation placeholders, not secrets. */
const ALLOW = [
  /sk-\.\.\./,
  /pk-\.\.\./,
  /YOUR_API_KEY/,
  /your-api-key/i,
  /<your[-_ ]?key>/i,
  /"apiKey"\s*:\s*""/,
  /API_KEY=\s*$/,
  /apiKeyEnv/,
  /\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET)\}?/,
];

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    const path = join(dir, entry.name);
    if (SKIP_FILES.has(entry.name) || SKIP_EXT.test(entry.name)) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    scan(path);
  }
}

function scan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      const lineText = text.split('\n')[line - 1] ?? '';
      if (ALLOW.some((pattern) => pattern.test(match[0]) || pattern.test(lineText))) continue;
      findings.push({ rule: rule.name, file: relative(root, path), line, sample: match[0].slice(0, 12) + '…' });
    }
  }
}

walk(root);

if (findings.length === 0) {
  console.log('secret scan: clean');
  process.exit(0);
}

console.error(`secret scan: ${findings.length} finding(s)`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  ${finding.rule}  (${finding.sample})`);
}
console.error('\nMove real values to a git-ignored file or an environment variable before publishing.');
process.exit(1);
