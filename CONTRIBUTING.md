# Contributing

Thanks for helping. This project is deliberately small: a framework-agnostic engine
(`src/engine/`) plus a thin DSH adapter (`src/dsh/`, `src/plugin.mjs`). Keeping that
split is the first rule — the engine must never import `@deepseek-ai/*`.

## Development setup

```bash
# Node 24 (or >= 22.5 for the engine alone)
node scripts/selftest.mjs        # offline: AST, storage, recall, tiering, recovery
node scripts/bench.mjs           # latency/size numbers for the README
```

The plugin dry-run and a real install need a machine with DSH:

```bash
node scripts/dryrun-plugin.mjs   # mounts the plugin on a stub Cordis context
node scripts/install.mjs --dry-run
```

If `@deepseek-ai/*` is not resolvable, the dry-run cannot start. On a DSH machine those
packages live in `~/.dsh/profiles/node_modules`; the linked copy under
`node_modules/@deepseek-ai` in this repo is a junction to the same files.

## What to change where

| Task | Files |
|---|---|
| New embedding provider | `src/engine/config.mjs` (`EMBED_PRESETS`) + README table |
| Better AST parsing | `src/engine/ast.mjs` + tests in `scripts/selftest.mjs` |
| Ranking / scoring | `src/engine/recall.mjs` (pure functions, add a test) |
| Storage schema | `src/engine/store.mjs` (`SCHEMA_SQL`, bump `SCHEMA_VERSION`, migration note) |
| Capture behaviour | `src/dsh/capture.mjs` |
| Injection / prompt | `src/dsh/inject.mjs`, `src/plugin.mjs` |
| New tool | `src/dsh/tools.mjs` |

Guidelines:

- **Engine stays dependency-free**: Node built-ins only (`node:sqlite`, `node:crypto`, ...).
- **Every behaviour change gets a check** in `scripts/selftest.mjs` (offline, fake embedder).
- **Never log or embed secrets.** Keys come from env or `credentials.json` only;
  `node scripts/check-secrets.mjs` must stay clean.
- **Keep default behaviour quiet**: memory capture is local, auto-recall is bounded and
  timed out, nothing is published outside the machine.
- **Schema changes** need a migration path: old databases are opened by new code, never
  silently corrupted (see `migrate()` / `ensureFts()`).
- **Performance changes** should quote `node scripts/bench.mjs` before/after.

## Pull requests

1. One concern per PR; describe the user-visible effect.
2. Include the test/bench output in the description.
3. Update `README.md`/`README.zh.md` when configuration or behaviour changes, and add a
   `CHANGELOG.md` entry.
4. If you touch recall scoring, explain the trade-off — those numbers were tuned against
   real failures, not intuition.

## Adding an embedding provider

```js
// src/engine/config.mjs
export const EMBED_PRESETS = {
  // ...
  myprovider: {
    baseUrl: 'https://api.example.com/v1',
    model: 'my-embedding-model',
    dimensions: 1024,
    sendDimensions: true,
  },
};
```

Then verify with:

```bash
MEMORY_TREE_EMBED_PRESET=myprovider MEMORY_TREE_API_KEY=... node scripts/selftest.mjs --live
```

## Ideas that are explicitly welcome

- `sqlite-vec` (or another ANN backend) behind the existing `store.listVectors` seam;
- offline consolidation (summaries, merge, conflict detection) for Phase 2;
- an MCP server wrapper around `src/engine/index.mjs`;
- a memory-graph visualisation (Three.js) fed by `nodes` + `edges`;
- translations of the README (Japanese, Korean, Spanish…).

## Code of conduct

Be technical, be kind. Disagreement about design is welcome; dismissiveness is not.
