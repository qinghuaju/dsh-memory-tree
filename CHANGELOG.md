# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows SemVer.

## [0.3.0] — publishable bundle

First release shaped for distribution outside this machine.

### Added

- **Bundle packaging**: `package.json` now declares `dsh.bundle.patch → cordis.patch.yml`, so adding
  `dsh-memory-tree` to a profile's `bundles` mounts the plugin without hand-editing the profile.
- **Bilingual tool & API reference**: `docs/TOOLS.md` / `docs/TOOLS.zh.md` cover the five tools,
  automatic recall, the engine API and the CLI.
- **Market tooling**: `scripts/market-index.mjs` generates a format-1 plugin-market index and
  `scripts/check-market.mjs` validates it without DSH dependencies; `docs/MARKET.md` /
  `docs/MARKET.zh.md` document hosting, adding the index in Discover, and the current "no default
  index" status of DSH 0.2.1-rc.3.
- **Install-from-Git** sections in both READMEs, including the profile-selection pitfall.

### Changed

- `check-secrets.mjs` skips git-ignored local directories (`.local/`, `local/`, vendor dumps) so a
  clean tree can be published without false positives.
- CI checks the bundle patch, the market index (optional) and the new scripts.

## [Unreleased] — injection hardening (verification pending)

Live incidents (21:56 and 15:10 local) share one signature: the first turn after
enabling `recall.autoInject` is marked `interrupted` **4 ms after `turn/start`**,
before any `step/start`, and the host then shuts down. There is no crash log and
`plugin.log` shows a healthy mount + warmup, so the engine is not implicated; the
remaining candidate is the auto-recall injection path interacting with the real
session/append pipeline (never exercised in a live run before these incidents).

### Added

- **Injection guard**: if the spliced decision would lose any claimed user
  message, the plugin abandons the injection and returns the original decision
  instead of risking an invalid batch.
- `injected recall: N nodes, M chars` at info level, so the next live attempt is
  visible in `plugin.log` even without debug logging.

### Notes

- The memory plugin is currently **not loaded** in the desktop profile; models
  were restored with `cordis.patch.yml.restore-models-only.yml`
  (also kept as `dsh-config-backup-models.yml` for recovery).
- Recommended re-enable order: `capture.enabled: true` with `autoInject: false`
  first; only after a stable session, enable `recall.autoInject`.

## [0.2.3] — assistant replies are actually captured

First verified live capture exposed a payload-shape mismatch: **every assistant
reply was silently dropped from memory**. DSH does not use one envelope for
message events:

```jsonc
// user/message      → data IS the message
{ "role": "user", "content": [...], "source": { "kind": "user" } }
// assistant/message → data wraps it
{ "turn": 1, "step": 1, "usage": {}, "stream": false,
  "message": { "role": "assistant", "content": [...], "source": { "kind": "model" } } }
```

The handler read `event.data` for both, so assistant text was empty and never
reached the buffer (user messages were unaffected). Fixed with one normalizer,
`messageOfEvent()`, plus a regression test that feeds the *real* wrapper shape and
then retrieves the assistant sentence from memory.

### Added

- `messageOfEvent(event)` in `src/dsh/inject.mjs`; all capture paths go through it.
- Dry-run now emits the real assistant envelope and asserts the reply is captured and retrievable (26 checks).

### Changed

- Capture flushes on `turn/end`, so one exchange becomes **one** document (user + assistant) instead of two half-documents.
- Debug logging for capture decisions (`buffer …`, `flush …`, `skip …`) is available with `logging.level: debug`.

## [0.2.2] — bounded shutdown

DSH reports `关闭超时` when a host child does not exit promptly; a plugin that
awaits in-flight work during dispose can therefore look like a crash/restart
failure. Memory teardown is now capped.

### Changed

- `client.stop()` sends `SIGKILL` to the engine child and waits at most 300 ms (was a 1.5 s SIGTERM handshake).
- The plugin's disposer races teardown against a 1 s budget, so `ctx.effect` can never hold host shutdown hostage.
- `CaptureBuffer.dispose()` no longer awaits in-flight flushes: documents are persisted before embedding, so an interrupted flush is retried as `pending` on the next start.
- Measured shutdown: **17 ms** instead of up to 30 s with an embedding request in flight.

### Notes

- `cordis.patch.yml` is owned by DSH's settings writer: manual entries can be dropped or reformatted when settings change, which also causes plugin reloads. Re-run `scripts/install.mjs` if the entry disappears.

## [0.2.1] — crash containment

A host process exited with code -1 during a turn while the plugin was enabled,
with no JavaScript stack in the crash log. Rather than guess, the engine was
moved out of the host process entirely so that no engine failure can end a
conversation again.

### Changed

- **Process isolation**: the DSH host now runs only a thin adapter (`src/plugin.mjs`, `src/dsh/host-client.mjs`). SQLite, embeddings, AST parsing and rotation run in a forked child (`src/dsh/engine-host.mjs`) over IPC. If the child crashes, the host survives, pending requests fail cleanly, and the client restarts the child (up to 3 times per 10 minutes, exponential backoff).
- **Engine runtime**: the child prefers DSH's bundled Node 24 (`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`) over the Electron binary, falling back to `process.execPath` + `ELECTRON_RUN_AS_NODE`. The host is Electron; keeping `node:sqlite` out of it removes the most likely native-crash surface for the original `-1` exit.
- **File diagnostics**: `$DSH_HOME/memory-tree/plugin.log` (rotating, 512 KB) records mount, child spawn/exit (including which runtime was used), stderr from the child and every engine warning. The previous incident left only the harness's startup stderr, which made root-cause analysis impossible.
- **Eager warmup**: the plugin boots the engine once at mount and logs `engine warmup ok (N documents)`, so a runtime or database problem is visible immediately instead of at the first turn.
- All engine operations in the child are serialized, so two captures cannot interleave transactions.

### Fixed

- **Self-recursion in the client spawn path**: the local `spawn` helper shadowed `child_process.spawn`, so `spawn()` called itself until the stack overflowed — an asynchronous throw that would have taken the host down. Caught by the new runtime test before release; the import is now aliased to `spawnProcess`.
- **FTS index maintenance**: `ensureFts()` used `nodes_fts MATCH '*'`, which throws `unknown special query` in this SQLite build, so every open triggered a full rebuild. It now counts rows directly, and `rebuildFts()` recreates the virtual table instead of an unsupported unqualified `DELETE`. Both paths are wrapped so a broken lexical index falls back to `LIKE` instead of failing the open.
- `apply()` is fully wrapped: a mount failure now logs and returns instead of propagating into the plugin loader. Child message/exit/stderr handlers and restart timers are individually guarded so a logging or handler error cannot escape.
- **Config schema defaults shadowed `config.json`**: DSH validates plugin config through `Config`, and per-field defaults were passed to `resolveConfig` as if the user had written them, silently overriding `$DSH_HOME/memory-tree/config.json` (the plugin ran with the Pollinations model while the key on disk belonged to DashScope). The schema now declares types only; defaults live in the engine and are applied after the file config is merged.

### Added

- `scripts/test-containment.mjs`: kills the engine child with `SIGKILL` and asserts the host survives, the client reports unavailability or recovers, and memory remains writable after the restart.
- `scripts/inspect.mjs` (read-only store inspection) and npm scripts `inspect`, `bench`.

## [0.2.0] — tiered storage and retrieval hardening

### Added

- **Tiered SQLite storage**: `memory.db` (hot) → `memory-warm.db` → `memory-cold.db`, rotated by document age (`storage.hotDays` / `warmDays`). Whole documents move with nodes and embeddings; recall spans every tier with per-tier weights; `dropColdVectors` trades cold semantic recall for a much smaller archive.
- **`mem_rotate` tool** plus a 6-hour rotation timer and a delayed startup rotation; rotation is batched (direct-to-final-tier dispatch, one transaction per hop).
- **`compact()`**: checkpoint → `journal_mode=DELETE` → `VACUUM` → back to WAL. Plain `VACUUM` under WAL leaves the main file at its old high-water mark (27 MB stayed 27 MB in testing); this sequence took the same hot file to 1.4 MB.
- **FTS5 lexical index** (`nodes_fts`, contentless) over latin words + CJK bigrams, replacing per-term `LIKE` scans; falls back to `LIKE` when FTS is unavailable.
- **In-process vector cache** keyed by a monotonic `data_version`, cutting 10k-node recall from 210 ms to 56 ms; bounded by `recall.vectorCacheMaxNodes`.
- **Bounded neighbour search** at index time (recent + lexical candidates instead of full pairwise), removing the O(N²) indexing cost (30k nodes: minutes → seconds).
- **Housekeeping**: embedding cache capped at 5k rows, recall log at 20k, with supporting indices.
- **`--copy-to` deployment mode**: installs the package into `<profile>/node_modules/dsh-memory-tree` (bare package name) or a custom location (shim), so deployment no longer depends on the checkout path.
- **Shared `config.json`**: `$DSH_HOME/memory-tree/config.json` is read as the base configuration by both the CLI and the plugin (patch config still overrides), so one machine has one embedding configuration.
- **Benchmark script** (`scripts/bench.mjs`) with published numbers for 1k/10k/30k nodes.
- **Docs**: bilingual README rewrite, `docs/DEPLOY.md` (+ zh), `docs/PRINCIPLES.md` (+ zh), `docs/GROWTH.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates, GitHub Actions CI.

### Changed

- `engine.store` is now a getter for the hot tier; `engine.stores` exposes every tier.
- `mem_stats` reports per-tier document/node/vector counts, sizes and paths.
- Rotation classifies a document straight to its final tier (no hot → warm → cold double move).

### Fixed

- Capture now stores only real conversation: a user message must carry `source.kind = 'user'` (custom kinds such as DSH's `time-context` snapshot were being remembered as user messages) and an assistant message must carry `'model'`. Covered by the dry-run suite.
- `capture.minChars` default lowered from 24 to 8 characters, so ordinary short Chinese messages are not silently dropped.
- README/PHASE1 scoring description now matches the implemented blend (similarity-led, not pure RRF).
- Temp-directory cleanup no longer leaks SQLite handles when tier stores are opened through `activeStores()`.

## [0.1.0] — Phase 1

### Added

- **AST soft-decision-tree memory** — deterministic parse (headings, numbered sections, bullets, paragraphs) into addressable nodes with unique paths; sections carry child content for embedding; long paragraphs split on sentence boundaries.
- **SQLite storage** (`node:sqlite`, WAL, single file) — `spaces` / `documents` / `nodes` / `vectors` / `edges` / `embed_cache` / `recalls` / `audit`; content-level dedupe through `documents(space_id, hash)`.
- **Embedding client** — OpenAI-compatible `/v1/embeddings`, provider presets (Pollinations Qwen3, DashScope, OpenAI, Ollama), batching, backoff retries, on-disk embedding cache, deterministic offline fake embedder.
- **Hybrid recall** — cosine scan + CJK-bigram lexical fallback, blended scoring (0.55 similarity / 0.20 lexical / 0.25 rank agreement) + one-hop tree activation + recency/importance/usage priors + diversity filter, all inside a bounded context budget.
- **`<memory-recall>` injection** — one extra plugin-sourced user message per turn, inserted after the claimed batch, escaped frame markers, per-turn dedupe, 1.5 s timeout and 60 s provider-failure cooldown.
- **Session capture** — buffered per session, coalesced per exchange, serialized background embedding, `failed → retry` recovery, Markdown mirror per document.
- **Project/global scoping** — project root discovered from `.git`, plus a shared `global` space for cross-project preferences.
- **Tools** — `mem_recall`, `mem_store`, `mem_stats`, `mem_dream`.
- **Installer** — writes a profile ESM shim, appends an idempotent `cordis.patch.yml` entry with backup, supports `--dry-run` and `--uninstall`.
- **Tests** — offline engine suite, live embedding suite, plugin dry-run against a stub Cordis context, and a secret scanner for pre-publish checks.

### Known limits

- Brute-force vector scan (tens of thousands of nodes; `sqlite-vec` is the planned upgrade).
- Keyword fallback uses SQL `LIKE` + CJK bigrams rather than BM25/FTS5.
- No offline consolidation (summaries/merge/abstraction) and no parameterized (LoRA) memory yet.
- No multi-machine sync; schema already carries `spaces`/`audit` for a later sync layer.
