/**
 * Embedding client (OpenAI-compatible `/v1/embeddings`).
 *
 * Works with Pollinations, DashScope/Qwen, OpenAI, a local Ollama, or any
 * compatible gateway. Requests are batched, retried with backoff, and cached in
 * the memory database so a repeated chunk or a repeated query never costs a
 * second round trip.
 *
 * @module dsh-memory-tree/engine/embed
 */

import { createHash } from 'node:crypto';
import { createLogger } from './log.mjs';
import { requiresApiKey, resolveApiKey } from './config.mjs';

/** Cache key for one exact model/dimension/text tuple. */
export function embeddingCacheKey(model, dimensions, text) {
  return createHash('sha256').update(`${model}|${dimensions}|${text}`).digest('hex');
}

/** Deterministic offline embedder: hashed character/word feature buckets. */
export function createFakeEmbedder({ dimensions = 256 } = {}) {
  const project = (text) => {
    const vec = new Float32Array(dimensions);
    const lower = String(text ?? '').toLowerCase();
    const features = [];
    for (const word of lower.matchAll(/[a-z0-9]{2,}/g)) features.push(`w:${word[0]}`);
    for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
      for (let i = 0; i < run.length; i += 1) {
        features.push(`u:${run[i]}`);
        if (i + 1 < run.length) features.push(`b:${run.slice(i, i + 2)}`);
      }
    }
    for (const feature of features) {
      const digest = createHash('sha256').update(feature).digest();
      const index = digest.readUInt32LE(0) % dimensions;
      const sign = digest[4] % 2 === 0 ? 1 : -1;
      vec[index] += sign * (1 + Math.min(3, feature.length / 8));
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
    return vec;
  };
  return {
    model: 'fake-hash-embedder',
    dimensions,
    fake: true,
    async embedTexts(texts) {
      return texts.map((text) => project(text));
    },
    describe() {
      return { model: 'fake-hash-embedder', dimensions, provider: 'fake', keySource: 'none' };
    },
  };
}

/**
 * @param {object} config - resolved plugin config (`resolveConfig`).
 * @param {{ logger?: object, fetchImpl?: Function, cache?: { get(key: string): Float32Array|null, set(key: string, vec: Float32Array): void } }} [options]
 */
export function createEmbedder(config, options = {}) {
  const logger = options.logger ?? createLogger({ level: config.logging?.level ?? 'info' });
  if (config.embedding.fake) return createFakeEmbedder({ dimensions: config.embedding.dimensions || 256 });

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cache = options.cache ?? null;
  const settings = config.embedding;
  const model = settings.model;
  const dimensions = settings.dimensions;
  let keyInfo = null;
  let keyNoticeShown = false;

  const baseUrl = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('dsh-memory-tree: embedding.baseUrl is empty. Set a preset or baseUrl.');
  if (typeof fetchImpl !== 'function') throw new Error('dsh-memory-tree: global fetch is unavailable.');

  const endpoint = `${baseUrl}/embeddings`;

  const apiKey = () => {
    if (keyInfo === null) {
      keyInfo = resolveApiKey(config);
      if (!keyInfo.apiKey && requiresApiKey(config)) {
        throw new Error(
          `dsh-memory-tree: no embedding API key. Set ${settings.apiKeyEnv || 'MEMORY_TREE_API_KEY'} ` +
            `or write {"apiKey":"..."} to ${settings.credentialsFile}. Endpoint: ${endpoint}`,
        );
      }
      if (!keyInfo.apiKey && !keyNoticeShown) {
        keyNoticeShown = true;
        logger.debug?.('embedding endpoint needs no API key (local provider)');
      }
    }
    return keyInfo;
  };

  const truncate = (text) => {
    const value = String(text ?? '');
    const max = settings.maxInputChars;
    return value.length > max ? `${value.slice(0, max)}\n…` : value;
  };

  const requestBatch = async (batch, { signal } = {}) => {
    const body = { model, input: batch };
    if (settings.sendDimensions && dimensions) body.dimensions = dimensions;
    const { apiKey: key } = apiKey();
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: composed,
        });
        if (!response.ok) {
          const detail = await safeText(response);
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt <= settings.maxRetries) {
            await backoff(attempt, response.headers?.get('retry-after'));
            continue;
          }
          throw new Error(`embedding request failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
        }
        const payload = await response.json();
        const rows = Array.isArray(payload?.data) ? [...payload.data] : [];
        if (rows.length !== batch.length) {
          throw new Error(`embedding response size mismatch: expected ${batch.length}, got ${rows.length}`);
        }
        rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
        return rows.map((row) => Float32Array.from(row.embedding ?? []));
      } catch (error) {
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        if (aborted && signal?.aborted) throw error;
        if (attempt <= settings.maxRetries) {
          await backoff(attempt, null);
          continue;
        }
        throw error;
      }
    }
  };

  const embedTexts = async (texts, { signal } = {}) => {
    const inputs = texts.map(truncate);
    const out = new Array(inputs.length);
    /** @type {Array<{ index: number, text: string }>} */
    const misses = [];
    const seen = new Map();

    inputs.forEach((text, index) => {
      const key = embeddingCacheKey(model, dimensions, text);
      if (seen.has(key)) {
        out[index] = seen.get(key);
        return;
      }
      const cached = cache?.get(key) ?? null;
      if (cached) {
        out[index] = cached;
        seen.set(key, cached);
        return;
      }
      misses.push({ index, text, key });
    });

    for (let offset = 0; offset < misses.length; offset += settings.batchSize) {
      const slice = misses.slice(offset, offset + settings.batchSize);
      const vectors = await requestBatch(
        slice.map((item) => item.text),
        { signal },
      );
      slice.forEach((item, i) => {
        const vector = vectors[i];
        out[item.index] = vector;
        seen.set(item.key, vector);
        try {
          cache?.set(item.key, vector);
        } catch (error) {
          logger.debug?.('embedding cache write failed', error?.message ?? error);
        }
      });
    }
    return out;
  };

  return {
    model,
    dimensions,
    fake: false,
    embedTexts,
    describe() {
      let source = 'unresolved';
      try {
        source = apiKey().source;
      } catch {
        source = 'missing';
      }
      return { model, dimensions, provider: baseUrl, keySource: source };
    },
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function backoff(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 350 * 2 ** (attempt - 1);
  const jitter = Math.random() * 150;
  return new Promise((resolve) => setTimeout(resolve, Math.min(8000, base + jitter)));
}
