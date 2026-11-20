/**
 * Append-only file logger for the host process and the engine child.
 *
 * The DSH host's stderr is captured only around a fatal exit, so anything that
 * happens earlier is invisible. This logger keeps a small rotating file next to
 * the database, which is what makes the next incident diagnosable.
 *
 * @module dsh-memory-tree/dsh/log-file
 */

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {{ file: string, maxBytes?: number, level?: string }} options
 */
export function createFileLogger({ file, maxBytes = 512 * 1024, level = 'info' }) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = levels[level] ?? levels.info;
  let broken = false;

  const rotateIfNeeded = () => {
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // Rotation is best effort; never let logging break the plugin.
    }
  };

  const write = (name, args) => {
    if (broken || (levels[name] ?? 100) < threshold) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      rotateIfNeeded();
      const message = args
        .map((arg) => {
          if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' ');
      appendFileSync(file, `${new Date().toISOString()} [${name}] ${message.slice(0, 8000)}\n`, 'utf8');
    } catch {
      broken = true;
    }
  };

  return {
    level,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    child: (scope) => createFileLogger({ file, maxBytes, level }),
  };
}
