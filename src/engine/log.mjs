/**
 * Minimal leveled logger. The DSH plugin passes its own `ctx.logger`, the CLI
 * and tests use this default. Kept dependency-free so the engine can run
 * outside DSH (CLI, tests, future MCP server).
 *
 * @module dsh-memory-tree/engine/log
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @param {{ level?: string, scope?: string, sink?: Pick<Console,'debug'|'info'|'warn'|'error'> }} [options]
 */
export function createLogger(options = {}) {
  const level = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
  const scope = options.scope ?? 'memory-tree';
  const sink = options.sink ?? console;
  const emit = (name, stream, args) => {
    if (LEVELS[name] < level) return;
    const fn = typeof sink[stream] === 'function' ? sink[stream] : sink.log;
    fn.call(sink, `[${scope}]`, ...args);
  };
  return {
    level: options.level ?? 'info',
    debug: (...args) => emit('debug', 'debug', args),
    info: (...args) => emit('info', 'info', args),
    warn: (...args) => emit('warn', 'warn', args),
    error: (...args) => emit('error', 'error', args),
    child: (childScope) => createLogger({ ...options, scope: `${scope}:${childScope}` }),
  };
}
