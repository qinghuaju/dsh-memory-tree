# Design notes

English | [中文](PRINCIPLES.zh.md)

Why this architecture and not "a vector store plus a prompt"? This document covers the
trade-offs, the measurements that changed the design, and the parts that are still weak.

## 1. Memory in the context window cannot work

Three hard limits, not a model-quality problem:

| Limit | Symptom | Consequence |
|---|---|---|
| Bounded context | a long task fills 100k–1M tokens | compaction is mandatory |
| Lossy compaction | summaries drop *why* a decision was made | details are unrecoverable |
| Rereading is expensive | replaying history every task | cost grows with session count |

So memory has to live outside the context: on disk, searchable, loaded on demand.

## 2. Why not "just another vector store"

Flat chunk RAG finds similar text, but memory also needs:

1. **Addressability** — "the optogenetics idea from last month" must resolve to
   `/optogenetics-and-bio-display/art/biological-display`, not "some similar chunk".
2. **Structure** — a hit paragraph should surface its section and sibling conclusions;
   flat chunks have no parent/child relation.
3. **Explainability** — which signals produced this score, and can it be audited?

So the tree is the skeleton (hard) and embeddings are the soft links. That is the
"soft decision tree": parse structure deterministically, traverse by similarity.

## 3. The AST

**Structure (hard).** Markdown headings, `1.`/`一、` numbered sections, bullets, and blank-line
paragraphs become nodes with unique paths. A section node embeds its heading *plus* its direct
paragraphs (≤1200 chars) so sections are retrievable by content. Long paragraphs split on
sentence boundaries (≤900 chars). Duplicate sibling titles get a `~2` suffix.

Cost: parsing is heuristic. A note with no headings degrades to paragraph nodes — still works,
just without the structural bonus.

**Links (soft).** Each new node gets up to three neighbours at cosine ≥ 0.72, stored as
`similar` edges. Recall performs exactly one activation hop:

```
hit ──0.55──▶ parent
    ──0.55×sim──▶ similar neighbour
```

Two hops decay below 0.3, which is noise level; measured recall gain was smaller than the
off-topic cost. `expansionDamping` is configurable.

**Neighbour search is bounded.** Comparing each new node to every stored vector is O(N²):
at 30k nodes a single write took minutes. Candidates come from the 120 most recent nodes plus
20 FTS (lexical) neighbours; batch rotation uses one lexical query over the moved text plus a
sample of the batch. This trades a little recall (distant, differently-worded cross-topic links)
for constant write cost. `mem_dream` still does a full pairwise rebuild when explicitly asked.

## 4. Scoring

```
candidates = vector top-K ∪ FTS top-K
base       = (0.55·cos + 0.20·lexical + 0.25·RRF) × tier weight
propagated = base × 0.55 (parent) or base × 0.55·sim (neighbour)
prior      = 0.06·importance + 0.05·exp(-age/45d) + 0.03·log1p(access)/log(8)
score      = propagated + prior
```

Each term earned its place:

- **Not pure RRF.** RRF differences are in the third decimal (1/60 vs 1/61). An earlier formula
  gave `access_count` a 0.06 weight, which completely swamped relevance: a previously recalled
  node always won. Similarity now carries 0.55.
- **Priors are tiny** on purpose: they break ties, they do not decide. Recency half-life is 45 days.
- **Diversity matters**: parent/child nodes and paraphrases often sit above 0.9 cosine; injecting
  six near-identical chunks wastes the budget. Candidates ≥ 0.88 similar to an already picked
  node are dropped.
- **Three budgets** (`maxNodes`, `maxChars`, `maxNodeChars`) keep the injected block bounded.

## 5. Tiered files

**Why files, not partitions.** SQLite has a single writer: smaller files mean shorter write
locks, simpler backup and migration. Cold data can be moved to slow storage or deleted wholesale
without touching the hot path. Every file is a valid SQLite database, and no extra service is
needed to hold memory.

| Tier | Default age | Vectors | Recall weight |
|---|---|---|---|
| hot `memory.db` | < 30 days | kept | 1.00 |
| warm `memory-warm.db` | 30–180 days | kept | 0.90 |
| cold `memory-cold.db` | > 180 days | kept, or dropped with `dropColdVectors` | 0.78 |

Rotation moves whole documents (documents + nodes + vectors, preserving paths and timestamps)
directly to their final tier — never hot → warm → cold twice. A cold tier without vectors still
matches keywords through FTS, just without semantic recall. Rotation is triggered by a timer,
a delayed startup task, and `mem_rotate`; all three can be disabled.

**A real trap: VACUUM does not shrink a WAL database.** After moving 96% of the rows away, the
hot file stayed at 27 MB because `VACUUM` rewrites pages through the WAL and leaves the main file
at its high-water mark. The fix is `checkpoint → journal_mode=DELETE → VACUUM → journal_mode=WAL`,
which took the same file to 1.4 MB. That is why `vacuumAfterRotate` defaults to off: it rewrites
the file and belongs to low-frequency maintenance.

## 6. Capture path

```
session/event ──▶ per-session buffer (user + assistant coalesced)
                    │ assistant reply then a new user message → flush now (turn boundary)
                    │ idle 1.5 s → flush
                    │ > 60 buffered messages → flush
                    ▼
              AST → nodes → embeddings → vectors → soft edges → Markdown mirror
```

- **No I/O in the event callback.** DSH dispatches `session/event` synchronously; blocking there
  blocks the agent loop.
- **Coalescing.** One exchange becomes one document, and the AST splits user/assistant into
  sections, so recall can tell who said what.
- **Serialized embeddings.** One request at a time avoids provider rate limits.
- **Recoverable failures.** The document is persisted as `pending` first; a failed embedding marks
  it `failed` and a timer retries every 2 minutes. The original text stays in `documents.text`,
  so retries never need the caller again.

## 7. Security boundary

Memory is untrusted input (web pages, other people's documents, the model itself):

1. Recalled text is wrapped in `<memory-recall>`; embedded frame tags are escaped to `‹…›` so content
   cannot close the block.
2. The system prompt states the block is reference material, not instructions, and that the current
   request wins on conflict.
3. Injected messages carry `source.kind = plugin, form = recall`; capture skips plugin sources, so
   memory never remembers itself.
4. Keys are read from env or a credentials file only — never logged, never in prompts, never in the
   patch file.
5. The plugin has no ability to post, comment, or email anything.

## 8. Limits and failure modes

| Limit | Current behaviour | When it bites | Mitigation |
|---|---|---|---|
| Full cosine scan | 1k ≈ 12 ms, 10k ≈ 60 ms, 30k ≈ 150 ms (local, fake embedder) | > ~50k nodes | `sqlite-vec` or a dedicated vector store |
| Approximate CJK tokenization | bigrams + FTS5 | rare names/acronyms | hybrid lexical + vector already helps |
| No consolidation layer | `mem_dream` dedupes and rebuilds edges | long-term redundancy | Phase 2: summaries, merge, conflict detection |
| No parameterized memory | no training | wanting "internalized" habits | Phase 3: rollbackable LoRA adapters |
| Single writer | two machines cannot share a file | multi-device | one-way sync, later CRDT |
| Model coupling | vectors from different models are incomparable | upgrading the embedding model | new `dataDir` or reindex |

## 9. Compared with neighbours

| Approach | Cross-session | Structure | Semantic search | Portable | Cost |
|---|---|---|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | partial, manual | plain text | none (full load) | yes | full prompt every turn |
| Flat vector RAG | yes | none | yes | vector-store dependent | per-query |
| Hosted memory services | yes | usually none | yes | no | subscription |
| **This project** | yes | AST + soft edges | yes | SQLite + Markdown | local embeddings (Ollama = free) |

## 10. Roadmap: when to train memory into weights

The order is deliberate: **retrieve first, consolidate second, parameterize last.**

- L0 working memory (context) — no persistence needed;
- L1 episodic memory (these SQLite nodes) — keep everything, retrieve on demand;
- L2 semantic memory (Phase 2) — offline summarization, dedupe, abstraction into rules;
- L3 parametric memory (Phase 3) — high-frequency, verified, cross-task experience into LoRA adapters;
- L4 persona/values — almost never updated.

Criterion: parameterize only when an experience is repeatedly validated *and* retrieval cost
exceeds the cost of internalizing it. Weights are not searchable, not explainable, and prone to
catastrophic forgetting; turning an auditable asset into a black box is a downgrade unless the
economics clearly favour it. That is why the foundation here is retrieval, not fine-tuning.
