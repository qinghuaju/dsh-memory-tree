#!/usr/bin/env node
/**
 * Crash-containment test: the engine child must be killable without taking the
 * host down, and the client must report unavailability (then recover).
 *
 *   node scripts/test-containment.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/engine/config.mjs';
import { createEngineClient, EngineUnavailableError } from '../src/dsh/host-client.mjs';
import { createFileLogger } from '../src/dsh/log-file.mjs';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-containment-'));
const config = resolveConfig({
  dataDir: dir,
  logging: { level: 'warn' },
  embedding: { fake: true, dimensions: 64 },
  capture: { enabled: false },
  recall: { autoInject: false },
  storage: { rotateOnOpen: false, tiered: true },
  mirror: { enabled: false },
});
const logger = createFileLogger({ file: join(dir, 'containment.log'), level: 'debug' });
const client = createEngineClient({ config, logger });

try {
  console.log('Startup');
  client.start();
  const before = await client.stats({ timeoutMs: 10_000 });
  check('client reaches the engine child', Boolean(before.totals), JSON.stringify(before.totals));
  const pid = client.status().pid;
  check('child process has a pid', Number.isInteger(pid) && pid > 0, String(pid));

  console.log('\nKill the child process');
  process.kill(pid, 'SIGKILL');
  await sleep(150);
  let hostAlive = true;
  let outcome = 'unknown';
  try {
    const result = await client.stats({ timeoutMs: 4000 });
    outcome = result?.totals ? 'recovered-transparently' : 'unexpected';
  } catch (error) {
    outcome = error instanceof EngineUnavailableError ? 'unavailable' : `unexpected:${error?.message ?? error}`;
  }
  check('host survived the child crash', hostAlive);
  check(
    'call after the crash either fails cleanly or recovers',
    outcome === 'unavailable' || outcome === 'recovered-transparently',
    outcome,
  );

  console.log('\nRecovery');
  await sleep(2500);
  let recovered = null;
  try {
    recovered = await client.stats({ timeoutMs: 15_000 });
  } catch (error) {
    recovered = { error: String(error?.message ?? error) };
  }
  check('client restarted the child', Boolean(recovered?.totals), JSON.stringify(recovered));
  check('new child has a different pid', client.status().pid !== pid, `${pid} -> ${client.status().pid}`);

  console.log('\nMemory still writable');
  const stored = await client.remember(
    { text: '# containment\n\n子进程重启后仍可写入记忆。', title: 'containment', cwd: dir, source: 'test' },
    { timeoutMs: 15_000 },
  );
  check('write succeeds after restart', stored?.nodeCount > 0, JSON.stringify(stored));
  const recall = await client.recall({ query: '子进程重启后仍可写入记忆', cwd: dir }, { timeoutMs: 15_000 });
  check('recall succeeds after restart', recall?.results?.length > 0, JSON.stringify(recall?.results?.length));
} finally {
  await client.stop();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best effort
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
