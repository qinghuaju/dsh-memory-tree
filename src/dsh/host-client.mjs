/**
 * Host-side client for the memory engine child process.
 *
 * The DSH host must never run `node:sqlite`, embeddings or the AST engine in its
 * own process: a fatal error there takes the whole conversation down with it
 * (observed once: the host exited with code -1 mid-turn). This client keeps the
 * host side to plain IPC and file logging, so the engine can die and be
 * restarted without affecting the harness.
 *
 * @module dsh-memory-tree/dsh/host-client
 */

import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ENTRY = fileURLToPath(new URL('./engine-host.mjs', import.meta.url));
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;
const READY_TIMEOUT_MS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Prefer DSH's bundled Node over the Electron binary.
 *
 * The host process is Electron, and `node:sqlite` behaviour under
 * ELECTRON_RUN_AS_NODE is exactly the kind of native surface that produced the
 * unexplained host exit this design exists for. The bundled runtime is a plain
 * Node 24 build that we have verified with the engine's own test suite.
 */
export function resolveNodeBinary(execPath = process.execPath, platform = process.platform) {
  const override = process.env.MEMORY_TREE_NODE;
  if (override && existsSync(override)) return { command: override, args: [], kind: 'override' };

  const execDir = dirname(execPath);
  const candidates =
    platform === 'win32'
      ? ['resources/runtime/primary-runtime/dependencies/node/bin/node.exe', 'resources/runtime/bin/node.exe']
      : ['resources/runtime/primary-runtime/dependencies/node/bin/node', 'resources/runtime/bin/node'];
  for (const relative of candidates) {
    const path = join(execDir, ...relative.split('/'));
    if (existsSync(path)) return { command: path, args: [], kind: 'bundled-node' };
  }
  // Fallback: the current executable must be a Node-compatible binary already
  // (plain `node` CLI, or Electron with ELECTRON_RUN_AS_NODE set by spawn()).
  return { command: execPath, args: [], kind: process.versions.electron ? 'electron-as-node' : 'node' };
}

export class EngineUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/**
 * @param {{ config: object, logger: object }} options
 */
export function createEngineClient({ config, logger }) {
  let child = null;
  let stopped = false;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
  const pending = new Map();
  /** @type {Array<number>} */
  const restarts = [];
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readyDone = false;

  const childConfig = () => {
    const clone = JSON.parse(JSON.stringify(config));
    if (clone.embedding) delete clone.embedding.apiKey;
    return clone;
  };

  const resetReady = () => {
    readyDone = false;
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // Avoid an unhandled rejection if nothing awaits readiness.
    readyPromise.catch(() => undefined);
  };

  const failPending = (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const scheduleRestart = () => {
    if (stopped) return;
    const now = Date.now();
    while (restarts.length > 0 && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      logger.warn?.(`engine child crashed ${restarts.length} times in 10 minutes; staying down until restart`);
      return;
    }
    restarts.push(now);
    const delay = 1000 * 2 ** (restarts.length - 1);
    logger.warn?.(`engine child exited; restarting in ${delay}ms`);
    const timer = setTimeout(() => {
      try {
        if (!stopped) spawn();
      } catch (error) {
        logger.error?.(`engine restart failed: ${error?.message ?? error}`);
      }
    }, delay);
    timer.unref?.();
  };

  const spawn = () => {
    if (stopped) return;
    if (child) return;
    resetReady();
    try {
      const env = {
        ...process.env,
        MEMORY_TREE_CONFIG: JSON.stringify(childConfig()),
      };
      if (config.embedding?.apiKey) env.MEMORY_TREE_API_KEY = String(config.embedding.apiKey);
      const node = resolveNodeBinary();
      if (node.kind === 'electron-as-node') env.ELECTRON_RUN_AS_NODE = '1';
      else delete env.ELECTRON_RUN_AS_NODE;
      child = spawnProcess(node.command, [...node.args, HOST_ENTRY], {
        env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      });
      logger.info?.(`engine child spawned (pid=${child.pid}, runtime=${node.kind})`);
      child.stderr?.on('data', (chunk) => {
        try {
          const text = String(chunk).trim();
          if (text) logger.error?.(`engine child stderr: ${text.slice(0, 4000)}`);
        } catch {
          // A logging failure must never escape a stream handler.
        }
      });
      child.on('message', (message) => {
        try {
          if (!message || typeof message !== 'object') return;
          if (message.event === 'ready') {
            readyDone = true;
            readyResolve?.(child?.pid ?? 0);
            return;
          }
          if (message.event === 'log') {
            const level = message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'debug';
            logger[level]?.(`[child] ${message.message}`);
            return;
          }
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.ok) entry.resolve(message.result);
          else entry.reject(new Error(message.error?.message ?? 'engine child error'));
        } catch (error) {
          logger.error?.(`failed to handle engine message: ${error?.message ?? error}`);
        }
      });
      child.on('error', (error) => {
        try {
          logger.error?.(`engine child error: ${error?.message ?? error}`);
        } catch {
          // ignore
        }
      });
      child.on('exit', (code, signal) => {
        try {
          logger.warn?.(`engine child exited (code=${code}, signal=${signal ?? 'none'})`);
          child = null;
          if (!readyDone) readyReject?.(new EngineUnavailableError('memory engine exited during startup'));
          readyDone = false;
          failPending(new EngineUnavailableError('memory engine process exited'));
          scheduleRestart();
        } catch (error) {
          logger.error?.(`failed to handle engine exit: ${error?.message ?? error}`);
        }
      });
    } catch (error) {
      child = null;
      logger.error?.(`failed to spawn engine child: ${error?.message ?? error}`);
      readyReject?.(new EngineUnavailableError(`cannot start memory engine: ${error?.message ?? error}`));
      scheduleRestart();
    }
  };

  const waitReady = async () => {
    if (!child) spawn();
    if (readyDone) return;
    let timer;
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new EngineUnavailableError('memory engine did not start in time')), READY_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };

  const request = async (method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    if (stopped) throw new EngineUnavailableError('memory engine is stopped');
    await waitReady();
    if (!child) throw new EngineUnavailableError('memory engine is not running');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EngineUnavailableError(`memory engine timed out on ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, method, params }, (error) => {
          if (!error) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(new EngineUnavailableError(`cannot reach memory engine: ${error.message}`));
        });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new EngineUnavailableError(`cannot reach memory engine: ${error?.message ?? error}`));
      }
    });
  };

  /** Fire-and-forget: capture must never add latency or surface an error. */
  const fire = (method, params) => {
    if (stopped || !child || !readyDone) {
      logger.debug?.(`engine not ready, dropping ${method}`);
      return;
    }
    const id = nextId++;
    try {
      child.send({ id, method, params }, () => undefined);
    } catch (error) {
      logger.debug?.(`drop ${method}: ${error?.message ?? error}`);
    }
  };

  /**
   * Bounded teardown. DSH reports "关闭超时" when the host child does not exit
   * quickly, so shutdown must never wait on an in-flight embedding request: kill
   * the engine child outright and return within ~300 ms.
   */
  const stop = async () => {
    stopped = true;
    failPending(new EngineUnavailableError('memory engine stopped'));
    const current = child;
    child = null;
    if (!current) return;
    const done = new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      timer.unref?.();
      current.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    try {
      current.kill('SIGKILL');
    } catch {
      // ignore
    }
    await done;
  };

  return {
    start: spawn,
    stop,
    status: () => ({ running: Boolean(child), ready: readyDone, pid: child?.pid ?? null }),
    request,
    fire,
    /** Boot the engine once at mount so the log records that SQLite opened. */
    warm: (options) => request('stats', {}, options),
    remember: (params, options) => request('remember', params, options),
    rememberExchange: (params, options) => request('rememberExchange', params, options),
    recall: (params, options) => request('recall', params, options),
    stats: (options) => request('stats', {}, options),
    dream: (params, options) => request('dream', params ?? {}, options),
    rotate: (params, options) => request('rotate', params ?? {}, options),
    flushPending: (params, options) => request('flushPending', params ?? {}, options),
    compact: (options) => request('compact', {}, options),
    describe: (options) => request('describe', {}, options),
  };
}
