#!/usr/bin/env node
/** Codex lifecycle hooks. Errors always fail open, stdout is hook JSON only. */
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngineClient } from '../runtime/client.mjs';
import { createFileLogger } from '../runtime/log-file.mjs';
import { adapterConfig } from '../runtime/cli.mjs';
import { redactSecrets } from '../engine/redact.mjs';
import { openCaptureQueue } from './queue.mjs';

async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Hook timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function handleCodexHook(event, { config, client, logger }) {
  if (!config.enabled || !event || typeof event.cwd !== 'string' || !isAbsolute(event.cwd) ||
    typeof event.session_id !== 'string' || !event.session_id) return {};
  const name = event.hook_event_name;
  if (!['UserPromptSubmit', 'Stop', 'SessionStart'].includes(name)) return {};
  if (name !== 'SessionStart' && (typeof event.turn_id !== 'string' || !event.turn_id)) return {};
  if (config.capture.excludeSessions.some(needle => needle &&
    (String(event.session_id).includes(needle) || event.cwd.includes(needle)))) return {};
  let queue;
  try {
    if (config.capture.enabled) {
      queue = openCaptureQueue(config);
      if (name === 'UserPromptSubmit' && typeof event.prompt === 'string') queue.prompt(event);
      if (name === 'Stop') queue.complete(event);
    }
    if (name === 'UserPromptSubmit') {
      const query = redactSecrets(String(event.prompt ?? '')).text.trim().slice(0, config.capture.maxChars);
      if (!config.recall.enabled || !config.recall.autoInject || query.length < config.recall.minQueryChars ||
        config.recall.skipQueryPrefixes.some(prefix => query.startsWith(prefix))) return {};
      const result = await bounded(() => client.recall({ query, cwd: event.cwd,
        sessionId: `codex:${event.session_id}`, limit: config.recall.maxNodes, maxChars: config.recall.maxChars,
      }, { timeoutMs: config.recall.timeoutMs }), config.recall.timeoutMs);
      return result.block ? { hookSpecificOutput: { hookEventName: name, additionalContext: result.block } } : {};
    }
    if (queue) {
      for (const item of queue.pending()) {
        try {
          await client.rememberExchange(item, { timeoutMs: 120_000 });
          queue.done(item.id);
        } catch {
          queue.failed(item.id);
          logger?.warn?.('Codex capture remains queued; retrying on a later Stop or SessionStart');
          break;
        }
      }
      queue.prune();
    }
    return {};
  } catch {
    logger?.warn?.(`Codex ${name} memory hook skipped; conversation continues`);
    return {};
  } finally { queue?.close(); }
}

async function main() {
  let client;
  let result = {};
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Hook input too large');
    }
    const event = JSON.parse(input);
    const config = adapterConfig();
    const logger = createFileLogger({ file: join(config.dataDir, 'plugin.log'), level: config.logging.level });
    client = createEngineClient({ config, logger });
    result = await handleCodexHook(event, { config, client, logger });
  } catch {
    // Malformed input/config and unavailable memory must never reject a Codex turn.
  } finally {
    await client?.stop();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
