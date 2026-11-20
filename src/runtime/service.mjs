/** Serialized, host-independent access to the engine. All adapters use this. */
import { createMemoryEngine } from '../engine/engine.mjs';
import { createOperationLock } from './operation-lock.mjs';

const METHODS = new Set(['remember', 'rememberExchange', 'recall', 'stats', 'dream',
  'rotate', 'flushPending', 'compact', 'describe']);

export function createEngineService({ config, logger }) {
  const lock = createOperationLock(config.dbPath);
  let engine;
  let serial = Promise.resolve();
  let closed = false;
  const timers = [];

  function checkEmbeddingIdentity() {
    const identity = JSON.stringify({ model: engine.embedder.model, dimensions: engine.embedder.dimensions });
    const previous = engine.store.getMeta('embedding_identity');
    if (previous && previous !== identity) throw new Error('Shared memory embedding model/dimensions differ. Use the same configuration or a separate dataDir.');
    if (!previous) {
      // Legacy databases have no identity marker; verify their stored vectors.
      engine.stats(); // Open existing tiers before inspecting them.
      for (const store of engine.stores.values()) {
        const models = store.requireDb().prepare('SELECT DISTINCT model, dim FROM vectors').all();
        if (models.some(row => row.model !== engine.embedder.model || Number(row.dim) !== engine.embedder.dimensions)) {
          throw new Error('Existing vectors use another embedding model/dimensions. Select the original configuration or a separate dataDir.');
        }
      }
      engine.store.setMeta('embedding_identity', identity);
    }
  }

  function request(method, params = {}, { deadline = Date.now() + 120_000 } = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error(`Unknown memory method: ${method}`));
    const task = serial.then(async () => {
      if (closed) throw new Error('Memory service is closed');
      if (!config.enabled) throw new Error('Memory is disabled by configuration');
      const release = await lock.acquire({ deadline });
      let timeout;
      try {
        engine ??= createMemoryEngine({ ...config, storage: { ...config.storage, rotateOnOpen: false } }, { logger });
        engine.init();
        checkEmbeddingIdentity();
        if (method === 'recall') {
          const abort = new AbortController();
          timeout = setTimeout(() => abort.abort(new Error('Memory recall timed out')), Math.max(1, deadline - Date.now()));
          return await engine.recall({ ...params, signal: abort.signal });
        }
        return await engine[method](params);
      } finally {
        clearTimeout(timeout);
        release();
      }
    });
    serial = task.catch(() => undefined);
    return task;
  }

  function maintain({ periodic = false } = {}) {
    const run = (method, params) => request(method, params, { deadline: Date.now() + 600_000 })
      .catch(() => logger?.warn?.(`Memory maintenance ${method} failed; will retry later`));
    if (config.storage.tiered && config.storage.rotateOnOpen) {
      timers.push(setTimeout(() => run('rotate', { reason: 'open' }), 5000));
    }
    if (periodic && config.storage.tiered && config.storage.rotateIntervalMs > 0) {
      timers.push(setInterval(() => run('rotate', { reason: 'timer' }), config.storage.rotateIntervalMs));
    }
    if (periodic && config.capture.retryPendingMs > 0) {
      timers.push(setInterval(() => run('flushPending', { limit: 10 }), config.capture.retryPendingMs));
    }
    timers.forEach(timer => timer.unref());
  }

  return {
    request, maintain,
    async close() {
      closed = true;
      timers.forEach(clearInterval);
      await serial;
      engine?.close();
      lock.close();
    },
  };
}
