/**
 * Memory engine: the framework-agnostic core used by the DSH plugin, the CLI
 * demo, the benchmark and the self-tests.
 *
 * Storage is tiered by age so one SQLite file never grows without bound:
 *
 *   memory.db        hot   — current project work (default: last 30 days)
 *   memory-warm.db   warm  — recent history (default: 30–180 days)
 *   memory-cold.db   cold  — long-term archive (default: older than 180 days)
 *
 * Recall scans every tier and blends them with a small tier prior, so old
 * memory stays reachable while the hot file stays small and fast. Rotation
 * moves whole documents (nodes + vectors) between files; nothing is deleted
 * silently, and the Markdown mirror remains the human-readable source of truth.
 *
 * @module dsh-memory-tree/engine
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './log.mjs';
import { resolveConfig } from './config.mjs';
import { MemoryStore, sha256 } from './store.mjs';
import { createEmbedder } from './embed.mjs';
import { redactSecrets } from './redact.mjs';
import { deriveTitle, normalizeText, parseMemoryTree, tokenize } from './ast.mjs';
import { GLOBAL_SPACE, displayPath, projectSpace, recallSpaces } from './space.mjs';
import { rankCandidates, renderRecallBlock, renderResultsText, pickConclusionNodes, mergeConclusionNodes } from './recall.mjs';

const SIMILAR_THRESHOLD = 0.72;
const SIMILAR_NEIGHBORS = 3;
const DAY_MS = 86_400_000;

/**
 * @param {object} rawConfig - plugin/CLI configuration (see `config.mjs`).
 * @param {{ logger?: object, fetchImpl?: Function, embedder?: object }} [options]
 */
export function createMemoryEngine(rawConfig = {}, options = {}) {
  const config = rawConfig.__resolved === true ? rawConfig : resolveConfig(rawConfig);
  const logger = options.logger ?? createLogger({ level: config.logging.level });
  /** @type {Map<string, MemoryStore>} */
  const stores = new Map();
  let initialized = false;
  let closed = false;

  const embedder =
    options.embedder ??
    createEmbedder(config, {
      logger,
      fetchImpl: options.fetchImpl,
      cache: {
        get: (key) => hotStore().getCachedVector(key),
        set: (key, vec) => hotStore().putCachedVector(key, config.embedding.model || 'unknown', vec),
      },
    });

  const tierPaths = () => {
    if (!config.storage.tiered) return { hot: config.dbPath };
    return {
      hot: config.dbPath,
      warm: config.storage.warmFile || join(config.dataDir, 'memory-warm.db'),
      cold: config.storage.coldFile || join(config.dataDir, 'memory-cold.db'),
    };
  };

  const storeFor = (tier) => {
    if (stores.has(tier)) return stores.get(tier);
    const path = tierPaths()[tier];
    if (!path) throw new Error(`unknown memory tier: ${tier}`);
    const store = new MemoryStore({ dbPath: path, tier, logger });
    store.open();
    stores.set(tier, store);
    return store;
  };

  const hotStore = () => storeFor('hot');

  /**
   * Per-tier vector cache. Re-reading and re-unpacking every 1024-dim BLOB on
   * each recall dominated latency at 10k+ nodes; the store's monotonic
   * `data_version` makes invalidation exact, including writes from the CLI.
   * @type {Map<string, { version: number, entries: Array<{nodeId: number, vec: Float32Array, norm: number}>, byId: Map<number, any> }>}
   */
  const vectorCache = new Map();

  const vectorsFor = (store, spaceIds) => {
    const key = `${store.tier}:${[...spaceIds].sort((a, b) => a - b).join(',')}`;
    const version = store.dataVersion();
    const cached = vectorCache.get(key);
    if (cached && cached.version === version) return cached;
    const entries = store.listVectors(spaceIds);
    const byId = new Map(entries.map((entry) => [entry.nodeId, entry]));
    const next = { version, entries, byId };
    if (config.recall.vectorCacheMaxNodes > 0 && entries.length <= config.recall.vectorCacheMaxNodes) {
      vectorCache.set(key, next);
    }
    return next;
  };

  /** Existing tiers in recall order (hot first). Never creates a tier file. */
  const activeStores = () => {
    const paths = tierPaths();
    const out = [{ tier: 'hot', store: storeFor('hot') }];
    for (const tier of ['warm', 'cold']) {
      if (!paths[tier]) continue;
      let store = stores.get(tier);
      if (!store) {
        const probe = new MemoryStore({ dbPath: paths[tier], tier, logger });
        if (!probe.exists()) continue;
        probe.open();
        stores.set(tier, probe);
        store = probe;
      }
      out.push({ tier, store });
    }
    return out;
  };

  const init = () => {
    if (closed) throw new Error('memory engine is closed');
    if (initialized) return;
    hotStore();
    // Housekeeping: the embedding cache and recall log are working state, not
    // memory content, and they otherwise dominate the hot file's size.
    hotStore().pruneEmbedCache(5000);
    hotStore().pruneRecalls(20_000);
    initialized = true;
    if (config.storage.rotateOnOpen) {
      // Defer: rotation can touch many rows and must never delay the first turn.
      setTimeout(() => {
        if (closed) return;
        rotate({ reason: 'open' }).catch((error) =>
          logger.debug?.(`rotation on open skipped: ${error?.message ?? error}`),
        );
      }, 5_000)?.unref?.();
    }
  };

  const spaceFor = ({ cwd, scope, space, spaceName }) => {
    if (space && typeof space === 'object' && space.key) return space;
    if (scope === 'global') return GLOBAL_SPACE;
    const resolved = projectSpace({ cwd: cwd || process.cwd() });
    return spaceName ? { ...resolved, name: String(spaceName) } : resolved;
  };

  /** Index one already-inserted document (AST parse → nodes → vectors → edges). */
  async function indexDocument(store, { documentId, text, title, importance, createdAt, space, source }) {
    const clean = normalizeText(text);
    const parsed = parseMemoryTree(clean, { title });
    const spaceRow = store.ensureSpace(space);

    const nodeIds = store.transaction(() => {
      store.deleteNodesByDoc(documentId);
      return store.insertNodes(spaceRow.id, documentId, parsed.nodes, { importance, createdAt });
    });
    const rows = store.listNodesByDoc(documentId);

    try {
      const inputs = rows.map((row) => truncateForEmbedding(row));
      const vectors = await embedder.embedTexts(inputs);
      rows.forEach((row, index) => store.putVector(Number(row.id), embedder.model, vectors[index]));
      store.updateDocumentStatus(documentId, 'ready');
      linkSimilar(
        store,
        spaceRow,
        rows.map((row) => ({ id: Number(row.id), title: row.title, content: row.content })),
      );
      writeMirror({ space: spaceRow, documentId, title, text: clean, createdAt, source, rows });
      store.audit('index', `document:${documentId}`, {
        space: spaceRow.key,
        nodes: rows.length,
        model: embedder.model,
        tier: store.tier,
      });
      return { nodeIds, nodeCount: rows.length, parsed };
    } catch (error) {
      store.updateDocumentStatus(documentId, 'failed', String(error?.message ?? error).slice(0, 500));
      throw error;
    }
  }

  /**
   * Add soft-similar edges for the freshly indexed nodes.
   *
   * Comparing each new node against every stored vector made indexing O(N²) and
   * dominated long sessions (30k nodes ⇒ ~9 minutes). Neighbours are therefore
   * drawn from two cheap candidate sets — lexical (FTS) neighbours and the most
   * recent nodes — which keeps per-document cost constant. `dream()` still does a
   * full pairwise rebuild when the user explicitly asks for it.
   */
  function linkSimilar(store, spaceRow, newRows, { batch = false } = {}) {
    if (newRows.length === 0) return 0;
    const newIds = newRows.map((row) => Number(row.id));
    const mine = store.getVectorsByNodeIds(newIds);
    if (mine.size === 0) return 0;

    // Candidate set, resolved once per call: recent nodes plus lexical
    // neighbours. A batch (rotation) uses one query over the moved text and a
    // sample of the batch itself, so cost stays linear in the batch size.
    const candidateIds = new Set(store.listRecentNodeIds(spaceRow.id, 120));
    if (batch) {
      const step = Math.max(1, Math.ceil(newRows.length / 300));
      const sample = newRows.filter((_, index) => index % step === 0);
      const text = sample
        .map((row) => `${row.title ?? ''} ${row.content ?? ''}`)
        .join(' ')
        .slice(0, 4000);
      const terms = tokenize(text).slice(0, 12);
      if (terms.length > 0) {
        for (const entry of store.ftsCandidates([spaceRow.id], terms, 40)) candidateIds.add(Number(entry.node.id));
      }
      for (const row of sample) candidateIds.add(Number(row.id));
    } else {
      for (const row of newRows) {
        const terms = tokenize(`${row.title ?? ''} ${row.content ?? ''}`).slice(0, 8);
        if (terms.length === 0) continue;
        for (const entry of store.ftsCandidates([spaceRow.id], terms, 20)) {
          candidateIds.add(Number(entry.node.id));
        }
      }
    }
    for (const id of newIds) candidateIds.delete(id);
    const candidateVectors = store.getVectorsByNodeIds([...candidateIds].slice(0, 800));

    const edges = [];
    for (const row of newRows) {
      const vector = mine.get(Number(row.id));
      if (!vector) continue;
      const scored = [];
      for (const [id, other] of candidateVectors) {
        if (id === Number(row.id)) continue;
        const sim = dot(vector.vec, other.vec, vector.norm, other.norm);
        if (sim >= SIMILAR_THRESHOLD) scored.push({ id, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (const neighbor of scored.slice(0, SIMILAR_NEIGHBORS)) {
        edges.push({ src: Number(row.id), dst: neighbor.id, kind: 'similar', weight: neighbor.sim });
      }
    }
    return store.addEdges(edges);
  }

  /**
   * Store one memory document in the hot tier.
   *
   * @param {{
   *   text: string, title?: string, cwd?: string, scope?: 'project'|'global',
   *   space?: object, source?: string, sessionId?: string, externalId?: string,
   *   importance?: number, tags?: string[], role?: string, createdAt?: string,
   * }} input
   */
  async function remember(input) {
    init();
    const store = hotStore();
    const redaction = redactSecrets(input.text);
    const text = normalizeText(redaction.text);
    if (!text) throw new Error('remember: empty text');
    if (redaction.redacted) {
      logger.warn?.(`redacted ${redaction.kinds.join(', ')} before storing`);
    }
    const space = spaceFor(input);
    const spaceRow = store.ensureSpace(space);
    const hash = sha256(text);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const title = redactSecrets(deriveTitle(input.title || firstHeading(text) || text, 80)).text;

    const inserted = store.insertDocument({
      spaceId: spaceRow.id,
      source: input.source ?? 'manual',
      externalId: input.externalId,
      sessionId: input.sessionId,
      title,
      hash,
      text,
      role: input.role,
      tags: input.tags ?? [],
      importance: clamp01(input.importance ?? 0.55),
      status: 'pending',
      createdAt,
    });

    if (inserted.deduped && inserted.status === 'ready') {
      return {
        documentId: inserted.id,
        nodeIds: store.listNodesByDoc(inserted.id).map((row) => Number(row.id)),
        deduped: true,
        space: spaceRow,
        nodeCount: 0,
        tier: 'hot',
      };
    }

    const result = await indexDocument(store, {
      documentId: inserted.id,
      text,
      title,
      importance: clamp01(input.importance ?? 0.55),
      createdAt,
      space: spaceRow,
      source: input.source ?? 'manual',
    });
    return {
      documentId: inserted.id,
      nodeIds: result.nodeIds,
      nodeCount: result.nodeCount,
      deduped: inserted.deduped,
      space: spaceRow,
      tier: 'hot',
    };
  }

  /**
   * Store one captured exchange (user/assistant messages from one turn).
   * @param {{ sessionId: string, cwd?: string, messages: Array<{role: string, text: string, time?: string}>, importance?: number }} input
   */
  async function rememberExchange(input) {
    const messages = (input.messages ?? []).filter((message) => normalizeText(message.text));
    if (messages.length === 0) return null;
    const body = messages
      .map((message) => {
        const label = message.role === 'assistant' ? '助手' : message.role === 'user' ? '用户' : message.role;
        return `## ${label}\n${normalizeText(message.text)}`;
      })
      .join('\n\n')
      .slice(0, config.capture.maxChars);
    const firstUser = messages.find((message) => message.role === 'user')?.text ?? body;
    return remember({
      text: body,
      title: deriveTitle(firstUser, 60),
      cwd: input.cwd,
      scope: 'project',
      source: 'capture',
      sessionId: input.sessionId,
      importance: input.importance ?? 0.5,
    });
  }

  /**
   * Retrieve memory relevant to a query across every active tier.
   *
   * @param {{ query: string, cwd?: string, scope?: string, limit?: number,
   *   maxChars?: number, sessionId?: string, pathPrefix?: string, signal?: AbortSignal }} input
   */
  async function recall(input) {
    init();
    const query = normalizeText(input.query);
    const limit = clampInt(input.limit ?? config.recall.maxNodes, 1, 40);
    if (!query) return { query, results: [], block: '', text: '未提供查询内容。', spaces: [] };

    const wanted = recallSpaces({ cwd: input.cwd, scope: input.scope ?? config.recall.scope });
    const wantedKeys = wanted.map((space) => space.key);

    const tiers = activeStores();
    const tierWeights = config.storage.tierWeights ?? { hot: 1, warm: 0.9, cold: 0.78 };

    const nodes = new Map();
    const sims = new Map();
    const vectors = new Map();
    const edgesByNode = new Map();
    const edgeSeeds = new Map();
    const pathToNode = new Map();
    const seedPaths = new Map();
    const lexicalEntries = [];
    const scoredAll = [];
    const usedSpaces = [];

    const [queryVector] = await embedder.embedTexts([query], { signal: input.signal });

    for (const { tier, store } of tiers) {
      const spaces = wantedKeys.map((key) => store.getSpaceByKey(key)).filter(Boolean);
      if (spaces.length === 0) continue;
      usedSpaces.push(...spaces);
      const spaceIds = spaces.map((space) => space.id);

      const allVectors = vectorsFor(store, spaceIds).entries;
      for (const vector of allVectors) {
        scoredAll.push({
          key: `${tier}:${vector.nodeId}`,
          tier,
          store,
          nodeId: vector.nodeId,
          sim: dot(queryVector, vector.vec, 1, vector.norm),
        });
        vectors.set(`${tier}:${vector.nodeId}`, vector);
      }

      const terms = tokenize(query).slice(0, 10);
      if (config.recall.lexicalTopK > 0) {
        for (const entry of store.lexicalCandidates(spaceIds, terms, config.recall.lexicalTopK)) {
          const key = `${tier}:${entry.node.id}`;
          const node = { ...entry.node, tier };
          nodes.set(key, node);
          lexicalEntries.push({ key, node, weight: Number(entry.weight) || 1 });
        }
      }
      edgeSeeds.set(tier, { store, spaceIds, ids: new Set() });
    }

    if (scoredAll.length === 0 && lexicalEntries.length === 0) {
      return { query, results: [], block: '', text: '长期记忆库为空（尚未捕获或写入任何内容）。', spaces: [] };
    }

    scoredAll.sort((a, b) => b.sim - a.sim);
    const vectorOrder = scoredAll
      .filter((entry) => entry.sim > 0.1)
      .slice(0, Math.max(config.recall.vectorTopK, limit * 4))
      .map((entry) => entry.key);
    for (const entry of scoredAll) sims.set(entry.key, entry.sim);

    // Fetch vector-candidate nodes and remember which ids each tier must expand.
    const byTier = new Map();
    for (const key of vectorOrder) {
      const [tier, id] = splitKey(key);
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier).push(Number(id));
    }
    for (const [tier, ids] of byTier) {
      const entry = edgeSeeds.get(tier);
      if (!entry) continue;
      for (const node of entry.store.getNodesByIds(ids).values()) {
        const key = `${tier}:${node.id}`;
        nodes.set(key, { ...node, tier });
        entry.ids.add(Number(node.id));
        if (node.parent_path) {
          if (!seedPaths.has(tier)) seedPaths.set(tier, new Set());
          seedPaths.get(tier).add(String(node.parent_path));
        }
      }
    }
    for (const { key, node } of lexicalEntries) {
      const entry = edgeSeeds.get(node.tier);
      if (!entry) continue;
      entry.ids.add(Number(node.id));
      if (node.parent_path) {
        if (!seedPaths.has(node.tier)) seedPaths.set(node.tier, new Set());
        seedPaths.get(node.tier).add(String(node.parent_path));
      }
    }

    // One soft hop: similar edges plus parent activation, resolved per tier.
    for (const [tier, entry] of edgeSeeds) {
      const ids = [...entry.ids];
      if (ids.length === 0) continue;
      const edges = entry.store.edgesFor(ids, ['similar']);
      for (const edge of edges) {
        const src = `${tier}:${edge.src}`;
        const dst = `${tier}:${edge.dst}`;
        pushEdge(edgesByNode, src, dst, Number(edge.weight));
        pushEdge(edgesByNode, dst, src, Number(edge.weight));
      }
      const parents = [...(seedPaths.get(tier) ?? [])];
      if (parents.length > 0) {
        for (const [path, nodeId] of entry.store.getNodeIdsByPaths(entry.spaceIds, parents)) {
          pathToNode.set(`${tier}|${path}`, `${tier}:${nodeId}`);
        }
      }
      const extra = new Set([
        ...edges.map((edge) => Number(edge.src)),
        ...edges.map((edge) => Number(edge.dst)),
      ]);
      for (const node of entry.store.getNodesByIds([...extra]).values()) {
        const key = `${tier}:${node.id}`;
        if (!nodes.has(key)) nodes.set(key, { ...node, tier });
      }
    }

    let ranked = rankCandidates({
      vectorOrder,
      sims,
      lexical: lexicalEntries,
      nodes,
      edgesByNode,
      pathToNode,
      vectors,
      tierWeights,
      config: { ...config.recall, maxNodes: limit },
    });

    if (input.pathPrefix) {
      const prefix = String(input.pathPrefix);
      ranked = ranked.filter((item) => String(item.node.path).includes(prefix));
    }

    const topRanked = ranked.slice(0, limit);

    /**
     * Conclusion bias: when one document dominates the result set, force its
     * tail — where the decision lives — into the block, evicting the weakest
     * early node. Never fails the recall: any error degrades to plain ranking.
     */
    const bias = config.recall.conclusionBias;
    let finalRanked = topRanked;
    if (bias?.enabled && bias.slots > 0 && limit >= 3 && topRanked.length >= 2 && queryVector) {
      try {
        const docCounts = new Map();
        for (const item of topRanked) {
          const docId = Number(item.node.doc_id);
          docCounts.set(docId, (docCounts.get(docId) ?? 0) + 1);
        }
        let mainDocId = null;
        let mainCount = 0;
        for (const [docId, count] of docCounts) {
          if (count > mainCount) {
            mainDocId = docId;
            mainCount = count;
          }
        }
        const anchor = mainDocId == null ? null : topRanked.find((item) => Number(item.node.doc_id) === mainDocId);
        if (anchor && mainCount >= 2) {
          const tier = anchor.node.tier;
          const store = stores.get(tier);
          const range = store?.docIdRange(mainDocId);
          if (range) {
            const cut = range.lo + bias.tailFraction * (range.hi - range.lo);
            const spaceIds = [Number(anchor.node.space_id)];
            const candidates = store
              .tailNodesForDoc(spaceIds, mainDocId, cut, bias.maxCandidates)
              .map((node) => ({ key: `${tier}:${node.id}`, node: { ...node, tier } }));
            const injected = pickConclusionNodes({
              selected: topRanked,
              candidates,
              vectorOf: (key) => vectors.get(key),
              queryVector,
              slots: bias.slots,
              minSimilarity: bias.minSimilarity,
            });
            finalRanked = mergeConclusionNodes({ items: topRanked, injected, cut, mainDocId });
          }
        }
      } catch (error) {
        logger.debug?.(`conclusion bias skipped: ${error?.message ?? error}`);
        finalRanked = topRanked;
      }
    }

    const touched = new Map();
    const results = finalRanked.map((item) => {
      const [tier, rawId] = splitKey(item.key);
      const nodeId = Number(rawId);
      if (!touched.has(tier)) touched.set(tier, []);
      touched.get(tier).push(nodeId);
      return {
        nodeId,
        tier,
        docId: Number(item.node.doc_id),
        path: String(item.node.path),
        title: String(item.node.title),
        kind: String(item.node.kind),
        content: String(item.node.content),
        createdAt: String(item.node.created_at),
        score: Number(item.score.toFixed(4)),
        reasons: item.reasons,
      };
    });

    for (const [tier, ids] of touched) {
      const store = stores.get(tier);
      if (!store) continue;
      try {
        store.transaction(() => {
          store.touchNodes(ids);
          store.recordRecall({
            sessionId: input.sessionId,
            spaceId: store.getSpaceByKey(wantedKeys[0])?.id ?? null,
            query,
            nodeIds: ids,
            scores: ids.map((id) => results.find((result) => result.nodeId === id && result.tier === tier)?.score ?? 0),
          });
        });
      } catch (error) {
        logger.debug?.(`recall audit write failed: ${error?.message ?? error}`);
      }
    }

    const block = renderRecallBlock(finalRanked, {
      maxChars: input.maxChars ?? config.recall.maxChars,
      maxNodeChars: config.recall.maxNodeChars,
      header: config.recall.header || undefined,
    });
    return { query, results, block, text: renderResultsText(finalRanked), spaces: usedSpaces };
  }

  /** Retry documents whose embedding failed, in every tier. */
  async function flushPending({ limit = 20 } = {}) {
    init();
    let processed = 0;
    let failed = 0;
    let pending = 0;
    for (const { store } of activeStores()) {
      const spaces = store.listSpaces();
      const byId = new Map(spaces.map((space) => [space.id, space]));
      const docs = store.listPendingDocuments([...byId.keys()], limit);
      pending += docs.length;
      for (const doc of docs) {
        const space = byId.get(Number(doc.space_id));
        if (!space) continue;
        try {
          await indexDocument(store, {
            documentId: Number(doc.id),
            text: doc.text ?? '',
            title: doc.title ?? '',
            importance: Number(doc.importance ?? 0.5),
            createdAt: doc.created_at,
            space,
            source: doc.source ?? 'retry',
          });
          processed += 1;
        } catch (error) {
          failed += 1;
          logger.warn?.(`retry failed for document ${doc.id}: ${error?.message ?? error}`);
        }
      }
    }
    return { processed, failed, pending };
  }

  /**
   * Move old documents from hot → warm → cold. Whole documents (nodes and
   * vectors) move; nothing is deleted unless `dropVectors` is set for cold.
   *
   * @param {{ now?: number, reason?: string, limitPerHop?: number, dryRun?: boolean }} [options]
   */
  async function rotate(options = {}) {
    if (closed) return { enabled: false, moved: [], reason: 'closed' };
    init();
    if (!config.storage.tiered) {
      return { enabled: false, moved: [], reason: 'storage.tiered=false' };
    }
    const now = options.now ?? Date.now();
    const limit = clampInt(options.limitPerHop ?? config.storage.rotateBatch, 1, 5000);
    const cutWarm = new Date(now - config.storage.hotDays * DAY_MS).toISOString();
    const cutCold = new Date(now - config.storage.warmDays * DAY_MS).toISOString();
    const dropVectors = Boolean(config.storage.dropColdVectors);
    const moved = [];

    // Classify once: an aged document goes straight to its final tier so a
    // single rotation never moves the same document twice (hot → warm → cold).
    const hot = storeFor('hot');
    const aged = hot.listDocumentsBefore(cutWarm, limit * 2);
    const toWarm = aged.filter((doc) => String(doc.created_at) >= cutCold);
    const toCold = aged.filter((doc) => String(doc.created_at) < cutCold);

    const plan = [
      { from: 'hot', to: 'warm', docs: toWarm, dropVectors: false },
      { from: 'hot', to: 'cold', docs: toCold, dropVectors },
    ];
    for (const hop of plan) {
      if (hop.docs.length === 0) continue;
      if (options.dryRun) {
        moved.push({ from: hop.from, to: hop.to, documents: hop.docs.length, nodes: 0, dryRun: true });
        continue;
      }
      const source = storeFor(hop.from);
      const target = storeFor(hop.to);
      const result = moveDocuments(source, target, hop.docs, { dropVectors: hop.dropVectors });
      moved.push({ from: hop.from, to: hop.to, documents: hop.docs.length, ...result });
    }

    // Warm is a separate source when it already exists (from earlier sessions).
    const warmPath = tierPaths().warm;
    if (warmPath) {
      const existing = stores.get('warm');
      const warm = existing ?? (existsSync(warmPath) ? storeFor('warm') : null);
      if (warm) {
        const docs = warm.listDocumentsBefore(cutCold, limit);
        if (docs.length > 0) {
          if (options.dryRun) {
            moved.push({ from: 'warm', to: 'cold', documents: docs.length, nodes: 0, dryRun: true });
          } else {
            const result = moveDocuments(warm, storeFor('cold'), docs, { dropVectors });
            moved.push({ from: 'warm', to: 'cold', documents: docs.length, ...result });
          }
        }
      }
    }

    if (moved.length > 0) {
      hotStore().setMeta('last_rotation', new Date(now).toISOString());
      hotStore().pruneEmbedCache(5000);
      hotStore().pruneRecalls(20_000);
      if (options.vacuum ?? config.storage.vacuumAfterRotate) compact();
      hotStore().audit('rotate', null, { moved, reason: options.reason ?? 'manual' });
    }
    return { enabled: true, moved, lastRotation: hotStore().getMeta('last_rotation') };
  }

  /** Reclaim disk space in every active tier (checkpoint + VACUUM). */
  function compact() {
    const result = [];
    for (const { tier, store } of activeStores()) {
      const before = store.fileSize().bytes;
      const ok = store.compact();
      result.push({ tier, ok, beforeBytes: before, afterBytes: store.fileSize().bytes });
    }
    return result;
  }

  /** Move whole documents between two stores, preserving paths and timestamps. */
  function moveDocuments(source, target, docs, { dropVectors = false } = {}) {
    let nodesMoved = 0;
    let documentsMoved = 0;
    let vectorsMoved = 0;
    const relink = new Map();
    /** @type {Array<{ docId: number, nodeIds: number[] }>} */
    const deletes = [];

    // Batch writes: per-row autocommit was the dominant cost of rotation.
    const tStart = performance.now();
    target.transaction(() => {
      for (const doc of docs) {
        const sourceSpace = source.getSpaceById(Number(doc.space_id));
        if (!sourceSpace) continue;
        const targetSpace = target.ensureSpace(sourceSpace);
        const nodes = source.listNodesByDoc(Number(doc.id));
        if (nodes.length === 0) {
          deletes.push({ docId: Number(doc.id), nodeIds: [] });
          documentsMoved += 1;
          continue;
        }
        const inserted = target.insertDocument({
          spaceId: targetSpace.id,
          source: doc.source,
          externalId: doc.external_id,
          sessionId: doc.session_id,
          title: doc.title,
          hash: doc.hash,
          text: doc.text,
          role: doc.role,
          tags: parseTags(doc.tags),
          importance: Number(doc.importance ?? 0.5),
          status: 'ready',
          createdAt: doc.created_at,
        });
        const ids = target.insertNodesRaw(targetSpace.id, inserted.id, nodes);
        const vectors = dropVectors ? [] : source.listVectorRecords(nodes.map((node) => Number(node.id)));
        for (const vector of vectors) {
          const index = nodes.findIndex((node) => Number(node.id) === vector.nodeId);
          if (index >= 0 && ids[index]) {
            target.putVector(ids[index], vector.model, vector.vec);
            vectorsMoved += 1;
          }
        }
        documentsMoved += 1;
        nodesMoved += nodes.length;
        deletes.push({ docId: Number(doc.id), nodeIds: nodes.map((node) => Number(node.id)) });
        if (!dropVectors) {
          // Keyed by the numeric space id: ensureSpace() returns a fresh object.
          const key = Number(targetSpace.id);
          if (!relink.has(key)) relink.set(key, { space: targetSpace, ids: [] });
          relink.get(key).ids.push(...ids);
        }
      }
    });

    const tInsert = performance.now();
    source.transaction(() => {
      for (const item of deletes) {
        if (item.nodeIds.length > 0) source.deleteEdgesForNodes(item.nodeIds);
        source.deleteDocument(item.docId);
      }
    });

    const tDelete = performance.now();
    for (const { space, ids } of relink.values()) {
      const rows = [...target.getNodesByIds(ids).values()].map((row) => ({
        id: Number(row.id),
        title: row.title,
        content: row.content,
      }));
      linkSimilar(target, space, rows, { batch: rows.length > 20 });
    }
    if (process.env.MEMTREE_PROFILE) {
      logger.warn?.(
        `[profile] move insert=${Math.round(tInsert - tStart)}ms delete=${Math.round(
          tDelete - tInsert,
        )}ms relink=${Math.round(performance.now() - tDelete)}ms docs=${docs.length}`,
      );
    }
    return { documents: documentsMoved, nodes: nodesMoved, vectors: vectorsMoved };
  }

  /** Dedupe nodes and rebuild soft edges in every active tier. */
  async function dream({ cwd, scope } = {}) {
    init();
    const spaces = recallSpaces({ cwd, scope: scope ?? config.recall.scope });
    const keys = new Set(spaces.map((space) => space.key));
    let removedNodes = 0;
    let edges = 0;
    const touched = [];
    for (const { tier, store } of activeStores()) {
      for (const space of store.listSpaces()) {
        if (!keys.has(space.key)) continue;
        touched.push(`${tier}:${space.key}`);
        removedNodes += store.dedupeNodes(space.id);
        store.clearEdges([space.id]);
        const all = store.listVectors([space.id]);
        if (all.length > 4000) {
          logger.warn?.(`dream: skipping edge rebuild for ${all.length} vectors in ${tier}:${space.key}`);
          continue;
        }
        const candidates = [];
        for (const entry of all) {
          const scored = [];
          for (const other of all) {
            if (other.nodeId === entry.nodeId) continue;
            const sim = dot(entry.vec, other.vec, entry.norm, other.norm);
            if (sim >= SIMILAR_THRESHOLD) scored.push({ id: other.nodeId, sim });
          }
          scored.sort((a, b) => b.sim - a.sim);
          for (const neighbor of scored.slice(0, SIMILAR_NEIGHBORS)) {
            candidates.push({ src: entry.nodeId, dst: neighbor.id, kind: 'similar', weight: neighbor.sim });
          }
        }
        edges += store.addEdges(candidates);
      }
    }
    hotStore().audit('dream', null, { removedNodes, edges, spaces: touched });
    return { removedNodes, edges, spaces: touched };
  }

  function stats() {
    init();
    const tierStats = [];
    for (const { tier, store } of activeStores()) {
      const spaces = store.listSpaceStats();
      tierStats.push({
        tier,
        dbPath: store.dbPath,
        ...store.stats(store.listSpaces()),
        sizeBytes: store.fileSize().bytes,
        spaces: spaces.map((space) => ({ ...space, tier })),
      });
    }
    const totals = tierStats.reduce(
      (acc, tier) => ({
        documents: acc.documents + tier.documents,
        nodes: acc.nodes + tier.nodes,
        vectors: acc.vectors + tier.vectors,
        pending: acc.pending + tier.pending,
        sizeBytes: acc.sizeBytes + tier.sizeBytes,
      }),
      { documents: 0, nodes: 0, vectors: 0, pending: 0, sizeBytes: 0 },
    );
    return {
      dbPath: config.dbPath,
      dataDir: config.dataDir,
      embedding: safeDescribe(),
      tiered: config.storage.tiered,
      tiers: tierStats,
      spaces: tierStats.flatMap((tier) => tier.spaces.map((space) => ({ ...space, tier: tier.tier }))),
      totals,
      mirrorDir: config.mirror.enabled ? config.mirror.dir : null,
    };
  }

  function safeDescribe() {
    try {
      return embedder.describe();
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }

  function writeMirror({ space, documentId, title, text, createdAt, source, rows }) {
    if (!config.mirror.enabled) return;
    try {
      const dir = join(config.mirror.dir, safeSegment(space.key));
      mkdirSync(dir, { recursive: true });
      const stamp = String(createdAt ?? new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
      const file = join(dir, `${stamp}-${String(documentId).padStart(6, '0')}-${safeSegment(title || 'memory')}.md`);
      const front = [
        '---',
        `title: ${JSON.stringify(title || '')}`,
        `space: ${JSON.stringify(space.key)}`,
        `source: ${JSON.stringify(source || 'manual')}`,
        `created_at: ${JSON.stringify(createdAt)}`,
        `document_id: ${documentId}`,
        `nodes: ${rows.length}`,
        '---',
        '',
      ].join('\n');
      writeFileSync(file, `${front}${text}\n`, 'utf8');
    } catch (error) {
      logger.warn?.(`markdown mirror write failed: ${error?.message ?? error}`);
    }
  }

  return {
    config,
    embedder,
    init,
    get store() {
      return hotStore();
    },
    storeFor,
    stores,
    remember,
    rememberExchange,
    recall,
    rotate,
    compact,
    flushPending,
    dream,
    stats,
    close: () => {
      closed = true;
      vectorCache.clear();
      for (const store of stores.values()) store.close();
      stores.clear();
    },
    describe: () => ({
      dbPath: config.dbPath,
      tiered: config.storage.tiered,
      embedding: safeDescribe(),
    }),
  };
}

function truncateForEmbedding(row) {
  const body = `${row.title}\n${row.content}`.trim();
  return body.length > 2400 ? body.slice(0, 2400) : body;
}

function pushEdge(map, from, to, weight) {
  if (!map.has(from)) map.set(from, []);
  map.get(from).push({ dst: to, weight });
}

function splitKey(key) {
  const index = String(key).indexOf(':');
  return [String(key).slice(0, index), String(key).slice(index + 1)];
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dot(a, b, normA = 1, normB = 1) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum / (normA * normB || 1);
}

function firstHeading(text) {
  const match = /^#{1,6}\s+(.+)$/m.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function safeSegment(text) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'memory';
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export { displayPath };
