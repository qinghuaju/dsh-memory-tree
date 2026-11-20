/** Shared flags for the standalone adapters; secrets stay in env/config files. */
import { resolve } from 'node:path';
import { resolveConfig } from '../engine/config.mjs';

export function adapterConfig(args = process.argv.slice(2)) {
  const raw = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1] && !args[i + 1].startsWith('--')) {
      raw.dataDir = resolve(args[++i]);
    } else if (args[i] === '--fake') {
      raw.embedding = { fake: true };
    } else {
      throw new Error(`Unsupported adapter argument: ${args[i]}`);
    }
  }
  return resolveConfig(raw);
}
