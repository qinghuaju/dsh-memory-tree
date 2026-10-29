/**
 * Public engine surface. Import this from a CLI, a future MCP server, tests, or
 * any host that is not DeepSeek Harness.
 *
 * @module dsh-memory-tree/engine/index
 */

export { createMemoryEngine } from './engine.mjs';
export { MemoryStore, SCHEMA_VERSION } from './store.mjs';
export { createEmbedder, createFakeEmbedder } from './embed.mjs';
export { resolveConfig, DEFAULT_CONFIG, EMBED_PRESETS, resolveApiKey } from './config.mjs';
export { parseMemoryTree, tokenize, normalizeText, outline } from './ast.mjs';
export { renderRecallBlock, renderResultsText, rankCandidates } from './recall.mjs';
export { projectSpace, recallSpaces, GLOBAL_SPACE } from './space.mjs';
export { createLogger } from './log.mjs';
