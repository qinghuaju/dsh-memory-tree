# dsh-memory-tree

**Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an AST-indexed, tiered SQLite brain that survives sessions.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-40%20offline%20checks-success.svg)](scripts/selftest.mjs)
[![ci](https://github.com/qinghuaju/dsh-memory-tree/actions/workflows/ci.yml/badge.svg)](https://github.com/qinghuaju/dsh-memory-tree/actions/workflows/ci.yml)
[![dsh](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

English | [中文](README.zh.md)

---

Your agent forgets. A task ends, the context is gone, the compaction summary dies with the
session, and a new task in the same project starts from zero. Notes you saved last month never
surface when a new idea connects to them.

This plugin makes memory an **asset on disk** instead of a consumable in the context window:

- **captures** every user/assistant exchange in the background,
- **indexes** it as an AST tree of addressable nodes with embeddings and soft similarity links,
- **recalls** relevant nodes before each turn and injects one bounded `<memory-recall>` block,
- **tiers** the data into hot/warm/cold SQLite files so the active file never grows with age,
- and exposes `mem_recall`, `mem_store`, `mem_stats`, `mem_dream`, `mem_rotate` as tools.

No external service. No native build. One directory you can copy, inspect, back up, or delete.

## Quick start

```bash
# 1) get the embedding key into place (never into the repo)
echo '{"apiKey":"sk-..."}' > "$DSH_HOME/memory-tree/credentials.json"

# 2) install into the profile the app actually loads, then restart DSH
#    desktop app → ~/.dsh/profiles/desktop   dsh web → ~/.dsh/profiles/web
node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to

# 3) verify inside DSH
#    ask the agent: call mem_stats
```

Chat two turns and ask about the first one from a **new session** — the recall block appears.

Other machines, npm/tarball, offline mode: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Install from Git

```bash
git clone https://github.com/qinghuaju/dsh-memory-tree.git
cd dsh-memory-tree

# pick the profile your DSH loads (desktop app vs `dsh web`)
node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to

# restart DSH, then ask the agent to call mem_stats
```

The installer is idempotent, backs up `cordis.patch.yml`, and never touches your keys. Without
`--profile` it targets the profile it finds and warns when both `desktop` and `web` exist.

## Install from the plugin market

DSH 0.2.1-rc.3 ships the market **off by default and with no index URL**. To publish or consume a
listing, generate `market/index.json` and add its URL in **Settings → Plugins → Discover**:

```bash
node scripts/market-index.mjs --owner qinghuaju --commit <40-hex-sha> --npm
node scripts/check-market.mjs
```

Full schema, hosting and the official-listing status: **[docs/MARKET.md](docs/MARKET.md)**.

## Compatibility

Tested with DSH **0.2.1-rc.3** (bundled Node 24) on Windows and Linux CI, Node ≥ 22.5 for CLI use.
The plugin has no native build and no runtime dependency tree of its own — it resolves DSH's
`@deepseek-ai/*` packages from the profile.


## Why not just a vector store?

| Need | Flat chunk RAG | This project |
|---|---|---|
| Find similar text | ✅ | ✅ embeddings |
| Address a memory ("the optogenetics idea") | ❌ anonymous chunks | ✅ unique AST paths |
| Surface a hit's section / siblings | ❌ | ✅ one-hop tree activation |
| Explain why something was recalled | ❌ one cosine number | ✅ six named score terms + audit rows |
| Bound the active database | ❌ grows forever | ✅ hot/warm/cold rotation |
| Work offline / no vendor | depends | ✅ Ollama or a deterministic fake embedder |
| Be inspected by a human | depends | ✅ Markdown mirror beside SQLite |

Details and the failures that shaped the design: **[docs/PRINCIPLES.md](docs/PRINCIPLES.md)**.

## How it works

```
session/event ──▶ capture buffer (per session, coalesced per exchange)
                    │
                    ▼
              AST parse ──▶ nodes (path, kind, title, content)
                    │
                    ▼
              embeddings ──▶ float32 vectors + similar edges (cos ≥ 0.72)
                    │
                    ▼
   memory.db (hot, <30d) ──rotate──▶ memory-warm.db (30–180d) ──▶ memory-cold.db (>180d)
                    │
   agent/pre-step ──▶ query ──▶ vector ∪ FTS candidates ──▶ blended score ──▶ <memory-recall>
```

Scoring (see [PRINCIPLES](docs/PRINCIPLES.md#4-scoring) for why each term exists):

```
base = (0.55·cosine + 0.20·lexical + 0.25·rank-agreement) × tier-weight
     + one hop: parent ×0.55, similar neighbour ×0.55·similarity
     + priors: 0.06·importance + 0.05·recency(45d) + 0.03·usage
```

## Measured behaviour

`node scripts/bench.mjs --sizes 1000,10000,30000` on this machine (Windows, Node 24, fake
embedder so the numbers measure storage + retrieval, not the network):

| nodes | DB size | recall p50 | recall p95 | rotation | hot file after rotation |
|---|---|---|---|---|---|
| 1,001 | 5.4 MB | 11.6 ms | 15.2 ms | 137 docs, 0.5 s | **0.36 MB** |
| 10,003 | 54.1 MB | 55.9 ms | 68.4 ms | 1,370 docs, 6.0 s | **2.48 MB** |
| 30,002 | 162.6 MB | 191.2 ms | 258.3 ms | 4,109 docs, 25.6 s | **7.23 MB** |

- ~5.4 KB per node (1024-dim vector ≈ 4 KB of it);
- the hot file only holds the retention window — that is the point of tiering;
- rotation moves documents, not copies; `compact()` reclaims the freed pages;
- real-world recall adds one embedding round trip; auto-recall is capped by `recall.timeoutMs`
  (1.5 s) and silently skipped when slow.

## Storage tiers

| Tier | File | Default age | Vectors | Recall weight |
|---|---|---|---|---|
| hot | `memory.db` | < 30 days | kept | 1.00 |
| warm | `memory-warm.db` | 30–180 days | kept | 0.90 |
| cold | `memory-cold.db` | > 180 days | kept (`dropColdVectors: true` to drop) | 0.78 |

Rotation runs on a timer (6 h), after startup, and on demand via `mem_rotate`. Whole documents
move with their nodes and embeddings; nothing is deleted. Dropping cold vectors keeps the archive
keyword-searchable at a fraction of the size.

Set `storage.tiered: false` for the old single-file behaviour.

## Configuration

```yaml
- insert:
    - id: dsh-memory-tree
      name: 'dsh-memory-tree'
      config:
        embedding:
          preset: pollinations     # pollinations | dashscope | openai | ollama | custom
          dimensions: 1024
        capture:
          enabled: true
        recall:
          autoInject: true
          maxNodes: 6
          timeoutMs: 1500
        storage:
          tiered: true
          hotDays: 30
          warmDays: 180
```

Every key with defaults: **[docs/PHASE1.md](docs/PHASE1.md)** (bilingual table); the Chinese
reference is in [README.zh.md](README.zh.md#配置).

The same configuration can live in `$DSH_HOME/memory-tree/config.json`, shared by the CLI and the
plugin (patch config still wins). Environment: `MEMORY_TREE_API_KEY`, `MEMORY_TREE_DATA_DIR`,
`MEMORY_TREE_EMBED_PRESET`.

## Tools

| Tool | Purpose |
|---|---|
| `mem_recall` | search project + global memory, optional path filter |
| `mem_store` | persist a durable note (`scope: global` for cross-project facts) |
| `mem_stats` | tiers, sizes, pending embeddings, spaces |
| `mem_dream` | dedupe nodes, rebuild soft edges |
| `mem_rotate` | move aged memories between tiers now |

Parameter tables, return shapes, the engine API and CLI flags: **[docs/TOOLS.md](docs/TOOLS.md)**.

## Safety by default

- **process isolation**: the engine (SQLite, embeddings, rotation) runs in a forked
  child process; if it dies, the conversation keeps going, the client restarts it,
  and the incident lands in `$DSH_HOME/memory-tree/plugin.log`;
- local-only storage; the only egress is the text sent for embedding;
- recalled content is framed as **untrusted reference material** and frame tags are escaped;
- injected messages are tagged and never re-captured (memory cannot remember itself);
- keys live in env / `credentials.json`, never in logs, prompts, or the patch file
  ([`scripts/check-secrets.mjs`](scripts/check-secrets.mjs) enforces this in CI);
- no posting, commenting, emailing, or arbitrary network calls — see [SECURITY.md](SECURITY.md).

## CLI

The same database is usable outside DSH:

```bash
node scripts/demo.mjs index ./notes --scope project
node scripts/demo.mjs recall "optogenetics art installation" --limit 5
node scripts/demo.mjs stats
node scripts/demo.mjs rotate
```

## FAQ

**Does it slow down as memory grows?**
Recall is a scan over the active spaces: 12 ms at 1k, 56 ms at 10k, 191 ms at 30k nodes on this
machine. Tiering keeps the hot file small; past ~50k nodes, wire up `sqlite-vec` behind
`store.listVectors` (the seam exists for it).

**Can I use it without a cloud key?**
Yes. `embedding.preset: ollama` with `bge-m3` runs fully local, and `embedding.fake: true` gives a
deterministic offline embedder for demos and tests.

**What if I change embedding models?**
Vectors from different models are incomparable. Use a new `dataDir` (or delete the tier files) and
let it re-index; the Markdown mirror keeps the raw text.

**Two machines?**
Copy `$DSH_HOME/memory-tree/` once, then never let both write the same SQLite file. One-way sync or
git on the Markdown mirror only. Multi-writer CRDT sync is on the roadmap.

**Does it replace `AGENTS.md` / `CLAUDE.md`?**
No — those are instructions you maintain; this is history the agent accumulates. They complement
each other.

**Is my conversation sent anywhere?**
Only the text chunks you capture, to your configured embedding endpoint. No telemetry, no upload
of the database.

## Roadmap

- [x] Phase 1 — AST + embeddings + SQLite, capture, auto-recall, tools, tiered files
- [ ] Phase 2 — offline consolidation: summaries, merge, conflict detection (`supersedes`), BM25
- [ ] Phase 3 — parameterized memory: rollbackable LoRA adapters trained from recall/decision logs
- [ ] Phase 4 — MCP server for non-DSH clients, CRDT multi-machine sync, 3D memory graph

Details: [docs/PHASE1.md](docs/PHASE1.md).

## Contributing

Issues and PRs welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md). The engine must stay
dependency-free, every behaviour change needs an offline check, and `check-secrets` must stay green.
If this saved you a session, a star helps other DSH users find it.

## License

MIT
