/**
 * Producer-owned source kinds used by the recall injection.
 *
 * Session format v4 refuses the retired `{ kind: 'plugin', plugin: '<pkg>' }`
 * wrapper ("format v4 message requires a producer-owned source kind") and
 * migrates it to `plugin:<pkg>`. A plugin that injects messages has to emit the
 * migrated shape itself, or the host rejects the whole turn.
 *
 * This module is dependency-free on purpose: `scripts/check-compat.mjs` and the
 * dry-run import it without a DSH runtime, so the rule is asserted in CI instead
 * of only being discovered on a user's machine.
 *
 * @module dsh-memory-tree/dsh/source-kind
 */

/** Producer-owned kind for the injected `<memory-recall>` message. */
export const RECALL_SOURCE_KIND = 'plugin:dsh-memory-tree';

/** Package name used by the retired v3 wrapper. */
export const PACKAGE_NAME = 'dsh-memory-tree';

/**
 * The v4 admission rule: a source kind must be a nonempty string and must not
 * be the retired wrapper name `plugin`.
 *
 * @param {{ kind?: unknown } | undefined | null} source
 * @returns {boolean}
 */
export function isProducerOwnedSource(source) {
  const kind = source?.kind;
  return typeof kind === 'string' && kind.length > 0 && kind !== 'plugin';
}

/**
 * True when the source is this plugin's current recall tag.
 *
 * @param {{ kind?: unknown, form?: unknown } | undefined | null} source
 * @returns {boolean}
 */
export function isRecallSource(source) {
  return source?.kind === RECALL_SOURCE_KIND;
}

/**
 * True for any source this plugin ever produced, including the retired v3
 * wrapper that 0.4.0 and earlier wrote into session logs.
 *
 * @param {{ kind?: unknown, plugin?: unknown } | undefined | null} source
 * @returns {boolean}
 */
export function isMemorySource(source) {
  if (!source) return false;
  if (source.kind === RECALL_SOURCE_KIND) return true;
  return source.kind === 'plugin' && source.plugin === PACKAGE_NAME;
}
