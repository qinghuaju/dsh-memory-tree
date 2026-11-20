#!/usr/bin/env node
/** Shared isolated engine process for DSH, Codex hooks and MCP. */
import { join } from 'node:path';
import { resolveConfig } from '../engine/config.mjs';
import { createFileLogger } from './log-file.mjs';
import { createEngineService } from './service.mjs';

const send = message => { try { process.send?.(message); } catch { /* parent gone */ } };
const raw = JSON.parse(process.env.MEMORY_TREE_CONFIG || '{}');
const config = resolveConfig(raw);
if (process.env.MEMORY_TREE_API_KEY) config.embedding.apiKey = process.env.MEMORY_TREE_API_KEY;
const logger = createFileLogger({ file: join(config.dataDir, 'plugin.log'), level: config.logging.level });
const service = createEngineService({ config, logger });
service.maintain({ periodic: process.env.MEMORY_TREE_MAINTENANCE === '1' });

process.on('message', message => {
  const { id, method, params, deadline } = message ?? {};
  if (typeof id !== 'number' || typeof method !== 'string') return;
  const operation = method === 'ping'
    ? Promise.resolve({ pid: process.pid, ready: true })
    : method === 'shutdown'
      ? service.close().then(() => ({ closed: true }))
      : service.request(method, params, { deadline });
  operation.then(
    result => send({ id, ok: true, result }),
    error => send({ id, ok: false, error: { message: String(error.message) } }),
  );
});

process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', () => { logger.error('Memory engine child crashed'); process.exit(1); });
process.on('unhandledRejection', () => { logger.error('Memory engine child rejected an unhandled operation'); process.exit(1); });
send({ event: 'ready', pid: process.pid });
