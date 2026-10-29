#!/usr/bin/env node
/**
 * Memory engine child process.
 *
 * The whole engine — SQLite, embeddings, AST parsing, rotation — runs here, in a
 * forked Node process. The DSH host only talks to it over IPC. If this child
 * dies (native crash, OOM, a fatal error), the host keeps working and the client
 * restarts it; the worst observable effect is "memory temporarily unavailable".
 *
 * Protocol (Node IPC):
 *   parent → child : { id, method, params }
 *   child → parent : { id, ok: true, result } | { id, ok: false, error: { message, stack } }
 *   child → parent : { event: 'ready', pid } | { event: 'log', level, message }
 *
 * Configuration arrives as a JSON blob in `MEMORY_TREE_CONFIG`; an API key may
 * arrive in `MEMORY_TREE_API_KEY` (DSH credentials resolved by the parent).
 *
 * @module dsh-memory-tree/dsh/engine-host
 */

import { join } from 'node:path';
import { createMemoryEngine } from '../engine/engine.mjs';
import { resolveConfig } from '../engine/config.mjs';
import { createFileLogger } from './log-file.mjs';

const send = (message) => {
  try {
    process.send?.(message);
  } catch {
    // Parent gone; nothing to report to.
  }
};

let logger = null;
const log = (level, ...args) => {
  try {
    logger?.[level]?.(...args);
  } catch {
    // ignore
  }
  send({ event: 'log', level, message: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ') });
};

const fatal = (error) => {
  log('error', `engine child fatal: ${error?.message ?? error}`);
  if (error?.stack) log('error', error.stack);
  process.exit(1);
};

process.on('uncaughtException', fatal);
process.on('unhandledRejection', (reason) => fatal(reason));

let engine = null;
const methods = {
  async remember(params) {
    engine ??= await boot();
    return engine.remember(params);
  },
  async rememberExchange(params) {
    engine ??= await boot();
    return engine.rememberExchange(params);
  },
  async recall(params) {
    engine ??= await boot();
    return engine.recall(params);
  },
  async stats() {
    engine ??= await boot();
    return engine.stats();
  },
  async dream(params) {
    engine ??= await boot();
    return engine.dream(params ?? {});
  },
  async rotate(params) {
    engine ??= await boot();
    return engine.rotate({ ...(params ?? {}), reason: params?.reason ?? 'timer' });
  },
  async flushPending(params) {
    engine ??= await boot();
    return engine.flushPending(params ?? {});
  },
  async compact() {
    engine ??= await boot();
    return engine.compact();
  },
  async describe() {
    engine ??= await boot();
    return engine.describe();
  },
  async shutdown() {
    if (engine) engine.close();
    engine = null;
    return { closed: true };
  },
  async ping() {
    return { pid: process.pid, ready: true };
  },
};

let booting = null;
const boot = async () => {
  if (engine) return engine;
  if (booting) return booting;
  booting = (async () => {
    const raw = process.env.MEMORY_TREE_CONFIG;
    if (!raw) throw new Error('engine child started without MEMORY_TREE_CONFIG');
    const parsed = JSON.parse(raw);
    const config = resolveConfig(parsed);
    if (process.env.MEMORY_TREE_API_KEY) config.embedding.apiKey = process.env.MEMORY_TREE_API_KEY;
    logger = createFileLogger({
      file: join(config.dataDir, 'plugin.log'),
      level: config.logging?.level ?? 'info',
    });
    const instance = createMemoryEngine(config, { logger });
    instance.init();
    log('info', `engine child ready (pid=${process.pid}, dataDir=${config.dataDir}, model=${config.embedding.model})`);
    return instance;
  })().finally(() => {
    booting = null;
  });
  engine = await booting;
  return engine;
};

let serial = Promise.resolve();

process.on('message', (message) => {
  const { id, method, params } = message ?? {};
  if (typeof id !== 'number' || typeof method !== 'string') return;
  // Serialize every operation: the engine is synchronous SQLite plus async
  // embeddings, and interleaving two captures would interleave transactions.
  serial = serial
    .then(async () => {
      const handler = methods[method];
      if (!handler) {
        send({ id, ok: false, error: { message: `unknown method: ${method}` } });
        return;
      }
      try {
        const result = await handler(params);
        send({ id, ok: true, result });
      } catch (error) {
        log('warn', `method ${method} failed: ${error?.message ?? error}`);
        send({ id, ok: false, error: { message: String(error?.message ?? error), stack: String(error?.stack ?? '') } });
      }
    })
    .catch((error) => {
      log('error', `serialized handler crashed: ${error?.message ?? error}`);
    });
});

process.on('SIGTERM', () => {
  try {
    engine?.close();
  } catch {
    // ignore
  }
  process.exit(0);
});

// Announce readiness for the IPC channel (engine itself boots lazily).
send({ event: 'ready', pid: process.pid });

// Keep the process alive until the parent disconnects.
process.on('disconnect', () => {
  try {
    engine?.close();
  } catch {
    // ignore
  }
  process.exit(0);
});
