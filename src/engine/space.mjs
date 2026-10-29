/**
 * Project/space resolution. A memory space is either the global space (shared
 * across every project) or a project space keyed by its root directory, so two
 * different projects never mix their episodic memory but can both recall the
 * global notes explicitly stored there.
 *
 * @module dsh-memory-tree/engine/space
 */

import { basename, dirname, join, normalize, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export const GLOBAL_SPACE = Object.freeze({
  key: 'global',
  name: 'Global',
  root: '',
  kind: 'global',
});

/** Normalize a path into a stable space key fragment. */
export function normalizeKeyPath(path) {
  const absolute = resolve(String(path));
  const slashed = absolute.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Walk up from `cwd` until a project-root marker is found.
 * Falls back to the starting directory when nothing matches.
 */
export function findProjectRoot(cwd, markers = ['.git']) {
  const start = resolve(cwd || process.cwd());
  let current = start;
  for (let depth = 0; depth < 40; depth += 1) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

/**
 * Resolve the project space for a working directory.
 *
 * @param {{ cwd?: string, markers?: string[], name?: string }} [options]
 * @returns {{ key: string, name: string, root: string, kind: string }}
 */
export function projectSpace({ cwd = process.cwd(), markers = ['.git'], name } = {}) {
  const safeCwd = resolve(cwd || process.cwd());
  const root = findProjectRoot(safeCwd, markers);
  return {
    key: `project:${normalizeKeyPath(root)}`,
    name: String(name || basename(root) || normalize(root)),
    root,
    kind: 'project',
  };
}

/** Resolve the space list a recall should search for one cwd/scope setting. */
export function recallSpaces({ cwd, scope = 'project+global', markers } = {}) {
  const spaces = [];
  if (scope !== 'global') spaces.push(projectSpace({ cwd, markers }));
  if (scope !== 'project') spaces.push(GLOBAL_SPACE);
  return spaces;
}

/** Best-effort display path (no trailing separator, forward slashes). */
export function displayPath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Whether a directory looks like it still exists. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
