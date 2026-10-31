/**
 * Configuration: defaults, normalization, provider presets, credential lookup.
 *
 * Nothing in this module ever logs or returns a secret into model-visible
 * content. Keys are read from an env var or from a git-ignored credentials file
 * under the data directory.
 *
 * @module dsh-memory-tree/engine/config
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Embedding provider presets (all OpenAI-compatible `/v1/embeddings`). */
export const EMBED_PRESETS = {
  /** Pollinations hosted Qwen3 embedding (zero-setup default). */
  pollinations: {
    baseUrl: 'https://gen.pollinations.ai/v1',
    model: 'qwen/qwen3-embedding-8b',
    dimensions: 1024,
    sendDimensions: true,
  },
  /** DashScope (Aliyun) Qwen3 text embedding, OpenAI-compatible mode. */
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'text-embedding-v4',
    dimensions: 1024,
    sendDimensions: true,
  },
  /** OpenAI. */
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimensions: 1024,
    sendDimensions: true,
  },
  /** Local Ollama (bge-m3). Requires `ollama pull bge-m3`; key is ignored. */
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'bge-m3',
    dimensions: 1024,
    sendDimensions: false,
  },
};

export const DEFAULT_CONFIG = {
  enabled: true,
  /** Directory holding memory.db, credentials.json and the Markdown mirror. */
  dataDir: '',
  logging: { level: 'info' },

  embedding: {
    /** preset name, or 'custom' to use baseUrl/model/dimensions verbatim. */
    preset: 'pollinations',
    baseUrl: '',
    model: '',
    dimensions: 1024,
    sendDimensions: undefined,
    /** Env var holding the API key. Falls back to POLLINATIONS_API_KEY. */
    apiKeyEnv: 'MEMORY_TREE_API_KEY',
    /** Extra fallback env vars, tried in order. */
    apiKeyEnvFallbacks: ['POLLINATIONS_API_KEY'],
    /** Optional literal key. Strongly discouraged; env/file wins for sharing. */
    apiKey: '',
    /** File with `{ "apiKey": "..." }`; defaults to `<dataDir>/credentials.json`. */
    credentialsFile: '',
    batchSize: 16,
    timeoutMs: 30_000,
    maxRetries: 2,
    /** Max embedding requests in flight across the capture queue. */
    maxConcurrent: 1,
    /** Chunk text sent to the model; longer text is truncated with a marker. */
    maxInputChars: 2000,
    /** Deterministic offline embedder for tests/air-gapped demos. */
    fake: false,
  },

  capture: {
    enabled: true,
    /** Ignore messages shorter than this (after trimming). */
    minChars: 8,
    /** One captured exchange never exceeds this many characters. */
    maxChars: 40_000,
    includeAssistant: true,
    /** Idle time after the last message before a buffered exchange is stored. */
    flushIdleMs: 1500,
    /** Hard cap of buffered messages per session. */
    maxBufferedMessages: 60,
    /** Never capture these session ids / cwds (substring match). */
    excludeSessions: [],
    /** Periodically retry documents whose embedding failed. */
    retryPendingMs: 120_000,
  },

  recall: {
    enabled: true,
    /** Inject a `<memory-recall>` message into the first step of a turn. */
    autoInject: true,
    /** Manual `mem_recall` results returned when auto-injection is off. */
    maxNodes: 6,
    maxChars: 2400,
    /** Per-node clip inside the rendered block. */
    maxNodeChars: 700,
    minQueryChars: 8,
    vectorTopK: 40,
    lexicalTopK: 30,
    /** RRF constant. */
    rrfK: 60,
    /** Damping for parent/child/similar activation spreading. */
    expansionDamping: 0.55,
    maxExpansionNodes: 24,
    /** Recency half-life in days for the freshness term. */
    recencyHalfLifeDays: 45,
    /** MMR-ish diversity threshold on cosine similarity. */
    diversityCosine: 0.88,

    /**
     * Keep unpacked vectors in memory up to this many per space (0 disables the
     * cache). ~4 KB per node at 1024 dims.
     */
    vectorCacheMaxNodes: 60_000,
    /** Skip auto-injection when retrieval takes longer than this. */
    timeoutMs: 1500,
    /** 'project+global' | 'project' | 'global' */
    scope: 'project+global',
    /** Do not inject when the query looks like a bare slash command / path. */
    skipQueryPrefixes: ['/', '!', '#'],

    /** Override the instruction line rendered inside `<memory-recall>`. */
    header: '',

    /**
     * Conclusion bias. Ranking favours a conversation's opening framing, so the
     * decision it actually converged on (near the end) frequently never reaches
     * the block. When one document dominates the result set, force up to
     * `slots` of its tail nodes in, replacing the weakest results.
     *
     * `minSimilarity` is the cosine floor for an injected tail node: a drifted
     * conversation whose tail is off-topic must not pollute the block.
     */
    conclusionBias: {
      enabled: true,
      slots: 1,
      minSimilarity: 0.45,
      /** Tail = nodes whose id is at or after this fraction of the doc's id range. */
      tailFraction: 0.8,
      maxCandidates: 12,
    },
  },

  tools: {
    enabled: true,
    /** Allow the model to write durable notes through `mem_store`. */
    allowStore: true,
    /** Allow `mem_dream` (dedupe + edge rebuild) from the model. */
    allowDream: true,
    /** Allow `mem_rotate` (tier rotation) from the model. */
    allowRotate: true,
  },

  /** Markdown mirror of every stored document (human-readable backup). */
  mirror: {
    enabled: true,
    /** '' means `<dataDir>/memory`. */
    dir: '',
  },

  /**
   * Tiered storage: bound the size of the hot database by moving whole
   * documents into warm/cold files as they age. Set `tiered: false` to keep the
   * single-file behaviour.
   */
  storage: {
    tiered: true,
    /** Documents older than this many days move hot 鈫?warm. */
    hotDays: 30,
    /** Documents older than this many days move warm 鈫?cold. */
    warmDays: 180,
    /** '' means `<dataDir>/memory-warm.db` / `memory-cold.db`. */
    warmFile: '',
    coldFile: '',
    /** Rotate in the background shortly after the plugin starts. */
    rotateOnOpen: true,
    /** Periodic rotation interval (0 disables the timer; the tool still works). */
    rotateIntervalMs: 6 * 60 * 60 * 1000,
    /** Documents moved per hop in one rotation pass. */
    rotateBatch: 200,
    /** Drop embeddings for cold documents (smaller archive, keyword-only recall). */
    dropColdVectors: false,
    /** Run VACUUM after a rotation that moved rows (slower, smaller files). */
    vacuumAfterRotate: false,
    /** Recall prior per tier: hot is the most likely place to find relevance. */
    tierWeights: { hot: 1, warm: 0.9, cold: 0.78 },
  },
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read one optional JSON config file; malformed content is ignored. */
function readJsonIfPresent(path) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Recursively merge `patch` over `base` (arrays and scalars replace). */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Expand `~` and resolve to an absolute path. */
export function expandPath(value, cwd = process.cwd()) {
  if (!value) return '';
  let text = String(value);
  if (text === '~') text = homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2));
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text);
}

/** `$DSH_HOME` when DSH sets it, else `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) return expandPath(explicit);
  return join(homedir(), '.dsh');
}

/**
 * Normalize user/plugin configuration into a fully-populated config object.
 * Unknown keys are preserved so forward-compatible callers keep working.
 */
export function resolveConfig(raw = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const provided = raw ?? {};
  const provisionalDataDir = expandPath(provided.dataDir || join(resolveDshHome(env), 'memory-tree'), cwd);
  // `<dataDir>/config.json` lets the CLI and the plugin share one configuration
  // (the plugin's patch config still wins). Do not set dataDir in that file.
  const fileConfig = readJsonIfPresent(join(provisionalDataDir, 'config.json'));
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), provided);
  const dataDir = expandPath(merged.dataDir || join(resolveDshHome(env), 'memory-tree'), cwd);

  const presetName = String(merged.embedding.preset || 'custom').toLowerCase();
  const preset = EMBED_PRESETS[presetName] ?? null;
  const embedding = {
    ...merged.embedding,
    preset: presetName,
    baseUrl: String(merged.embedding.baseUrl || preset?.baseUrl || '').replace(/\/+$/, ''),
    model: String(merged.embedding.model || preset?.model || ''),
    dimensions: Number(merged.embedding.dimensions || preset?.dimensions || 0) || 0,
    sendDimensions:
      merged.embedding.sendDimensions === undefined
        ? Boolean(preset?.sendDimensions ?? true)
        : Boolean(merged.embedding.sendDimensions),
    credentialsFile:
      expandPath(merged.embedding.credentialsFile, cwd) || join(dataDir, 'credentials.json'),
    apiKeyEnv: String(merged.embedding.apiKeyEnv || '').trim(),
    apiKeyEnvFallbacks: (merged.embedding.apiKeyEnvFallbacks ?? [])
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  };
  embedding.apiKey = String(merged.embedding.apiKey || '');

  const recall = {
    ...merged.recall,
    maxNodes: clampInt(merged.recall.maxNodes, 1, 40, 6),
    maxChars: clampInt(merged.recall.maxChars, 200, 40_000, 2400),
    maxNodeChars: clampInt(merged.recall.maxNodeChars, 80, 4000, 700),
    minQueryChars: clampInt(merged.recall.minQueryChars, 0, 10_000, 8),
    vectorTopK: clampInt(merged.recall.vectorTopK, 1, 400, 40),
    lexicalTopK: clampInt(merged.recall.lexicalTopK, 0, 400, 30),
    rrfK: clampInt(merged.recall.rrfK, 1, 1000, 60),
    expansionDamping: clampNumber(merged.recall.expansionDamping, 0, 1, 0.55),
    maxExpansionNodes: clampInt(merged.recall.maxExpansionNodes, 0, 200, 24),
    recencyHalfLifeDays: clampNumber(merged.recall.recencyHalfLifeDays, 1, 3650, 45),
    diversityCosine: clampNumber(merged.recall.diversityCosine, 0.5, 1, 0.88),
    vectorCacheMaxNodes: clampInt(merged.recall.vectorCacheMaxNodes, 0, 5_000_000, 60_000),
    timeoutMs: clampInt(merged.recall.timeoutMs, 100, 60_000, 1500),
    scope: ['project+global', 'project', 'global'].includes(merged.recall.scope)
      ? merged.recall.scope
      : 'project+global',
    skipQueryPrefixes: Array.isArray(merged.recall.skipQueryPrefixes)
      ? merged.recall.skipQueryPrefixes.map(String)
      : DEFAULT_CONFIG.recall.skipQueryPrefixes,
    conclusionBias: {
      enabled: merged.recall.conclusionBias?.enabled !== false,
      slots: clampInt(merged.recall.conclusionBias?.slots, 0, 4, 1),
      minSimilarity: clampNumber(merged.recall.conclusionBias?.minSimilarity, 0, 1, 0.45),
      tailFraction: clampNumber(merged.recall.conclusionBias?.tailFraction, 0.3, 1, 0.8),
      maxCandidates: clampInt(merged.recall.conclusionBias?.maxCandidates, 1, 200, 12),
    },
  };

  const capture = {
    ...merged.capture,
    minChars: clampInt(merged.capture.minChars, 0, 100_000, 8),
    maxChars: clampInt(merged.capture.maxChars, 500, 400_000, 40_000),
    flushIdleMs: clampInt(merged.capture.flushIdleMs, 50, 60_000, 1500),
    maxBufferedMessages: clampInt(merged.capture.maxBufferedMessages, 1, 500, 60),
    retryPendingMs: clampInt(merged.capture.retryPendingMs, 0, 3_600_000, 120_000),
    excludeSessions: Array.isArray(merged.capture.excludeSessions)
      ? merged.capture.excludeSessions.map(String)
      : [],
  };

  return {
    // Marks a fully-normalized config so nested engine construction reuses this
    // exact object (async DSH credential resolution then mutates the live config).
    __resolved: true,
    ...merged,
    dataDir,
    dbPath: expandPath(merged.dbPath || join(dataDir, 'memory.db'), cwd),
    embedding,
    recall,
    capture,
    storage: {
      ...merged.storage,
      tiered: merged.storage.tiered !== false,
      hotDays: clampInt(merged.storage.hotDays, 1, 3650, 30),
      warmDays: clampInt(merged.storage.warmDays, 1, 36_500, 180),
      rotateOnOpen: merged.storage.rotateOnOpen !== false,
      rotateIntervalMs: clampInt(merged.storage.rotateIntervalMs, 0, 86_400_000, 6 * 60 * 60 * 1000),
      rotateBatch: clampInt(merged.storage.rotateBatch, 1, 5000, 200),
      dropColdVectors: Boolean(merged.storage.dropColdVectors),
      vacuumAfterRotate: Boolean(merged.storage.vacuumAfterRotate),
      warmFile: expandPath(merged.storage.warmFile, cwd) || join(dataDir, 'memory-warm.db'),
      coldFile: expandPath(merged.storage.coldFile, cwd) || join(dataDir, 'memory-cold.db'),
      tierWeights: {
        hot: Number(merged.storage.tierWeights?.hot ?? 1),
        warm: Number(merged.storage.tierWeights?.warm ?? 0.9),
        cold: Number(merged.storage.tierWeights?.cold ?? 0.78),
      },
    },
    tools: { ...merged.tools },
    mirror: {
      ...merged.mirror,
      dir: expandPath(merged.mirror.dir || join(dataDir, 'memory'), cwd),
    },
    logging: { level: String(merged.logging?.level || 'info') },
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the embedding API key without ever exposing it in logs.
 * Order: explicit config 鈫?credentials file 鈫?env var 鈫?env fallbacks.
 *
 * @returns {{ apiKey: string, source: string }}
 */
export function resolveApiKey(config, { env = process.env } = {}) {
  const embedding = config.embedding ?? {};
  if (embedding.apiKey) return { apiKey: String(embedding.apiKey), source: 'config' };

  const file = embedding.credentialsFile;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const key =
        parsed?.apiKey ??
        parsed?.embedding?.apiKey ??
        parsed?.pollinations?.apiKey ??
        parsed?.providers?.pollinations?.apiKey;
      if (typeof key === 'string' && key.trim()) {
        return { apiKey: key.trim(), source: `file:${file}` };
      }
    } catch {
      // A malformed credentials file must not take the plugin down.
    }
  }

  const names = [embedding.apiKeyEnv, ...(embedding.apiKeyEnvFallbacks ?? [])].filter(Boolean);
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return { apiKey: value.trim(), source: `env:${name}` };
    }
  }
  return { apiKey: '', source: 'none' };
}

/** True when the configured endpoint needs a key (local Ollama does not). */
export function requiresApiKey(config) {
  if (config.embedding.fake) return false;
  try {
    const url = new URL(config.embedding.baseUrl);
    const host = url.hostname;
    return !(host === '127.0.0.1' || host === 'localhost' || host === '::1');
  } catch {
    return true;
  }
}
