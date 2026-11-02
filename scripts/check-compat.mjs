#!/usr/bin/env node
/**
 * Compatibility guard.
 *
 * Everything here is a rule that a future DSH build can silently invalidate.
 * It runs without a DSH runtime on purpose, so CI fails on the same day the
 * rule changes instead of the plugin failing on a user's machine.
 *
 *   node scripts/check-compat.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_NAME,
  RECALL_SOURCE_KIND,
  isMemorySource,
  isProducerOwnedSource,
} from '../src/dsh/source-kind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('Package metadata');
check('declares engines.node', typeof pkg.engines?.node === 'string' && pkg.engines.node.length > 0, pkg.engines?.node);
check('declares engines.dsh', typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0, pkg.engines?.dsh);
check('declares the bundle patch', pkg.dsh?.bundle?.patch === 'cordis.patch.yml', pkg.dsh?.bundle?.patch);
check('bundle patch file exists', existsSync(join(ROOT, pkg.dsh?.bundle?.patch ?? 'missing')));

console.log('\nSession-format v4 source rules');
check(
  'recall kind is plugin:<package>',
  RECALL_SOURCE_KIND === `plugin:${pkg.name}` && PACKAGE_NAME === pkg.name,
  RECALL_SOURCE_KIND,
);
check('recall kind passes the v4 admission rule', isProducerOwnedSource({ kind: RECALL_SOURCE_KIND }));
check('the retired wrapper is rejected by that rule', isProducerOwnedSource({ kind: 'plugin' }) === false);
check('an empty kind is rejected by that rule', isProducerOwnedSource({ kind: '' }) === false);
check('v3 blocks written by 0.4.0 stay recognisable', isMemorySource({ kind: 'plugin', plugin: pkg.name }));
check('the current kind is recognisable', isMemorySource({ kind: RECALL_SOURCE_KIND, form: 'recall' }));
check(
  "another plugin's wrapper is not ours",
  isMemorySource({ kind: 'plugin', plugin: 'some-other-plugin' }) === false,
);

console.log('\nShipped sources');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const inject = stripComments(readFileSync(join(ROOT, 'src', 'dsh', 'inject.mjs'), 'utf8'));
check("inject.mjs never hard-codes the retired kind: 'plugin'", !/kind:\s*'plugin'/.test(inject));
check('inject.mjs builds the message from the shared kind', inject.includes('RECALL_SOURCE_KIND'));

const plugin = readFileSync(join(ROOT, 'src', 'plugin.mjs'), 'utf8');
check('plugin declares its injected services', /export const inject\s*=\s*\[/.test(plugin));
check('plugin has an injection circuit breaker', plugin.includes('disableInjection'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
