# 部署到另一台机器 / Deploying to another machine

English | [中文](DEPLOY.zh.md)

The plugin is plain ESM + Node built-ins: no native build, no external database, no service to run.
That means "deployment" is copying files and pointing a DSH profile at them.

## 0. Requirements

| Item | Requirement | Notes |
|---|---|---|
| DSH | 0.1.x or newer | ships Node 24, so `node:sqlite` is available |
| Node (CLI use) | ≥ 22.5 | only needed if you also run `scripts/*.mjs` outside DSH |
| Disk | ~6 KB per memory node | 1k nodes ≈ 9 MB, 30k ≈ 170 MB (see benchmark) |
| Embedding API | any OpenAI-compatible `/v1/embeddings` | Pollinations (default), DashScope, OpenAI, Ollama |
| Network | outbound HTTPS to the embedding endpoint | fully local with Ollama; no network with `embedding.fake` |

## 1. Pick a deployment shape

### A. Package copy (recommended for other machines)

Anything that ends up inside the profile's `node_modules` resolves DSH's own
`@deepseek-ai/*` packages from `~/.dsh/profiles/node_modules`, so the plugin has
no dependency tree of its own.

```bash
# 1) copy this repository to the target machine (git clone / zip / scp)
# 2) from inside the copied folder:
node scripts/install.mjs --dry-run          # inspect what will change
node scripts/install.mjs --copy-to          # installs into <profile>/node_modules/dsh-memory-tree
```

> **Which profile?** The desktop app loads `~/.dsh/profiles/desktop`; a `dsh web`
> CLI server loads `~/.dsh/profiles/web`. Installing into the wrong one means the
> plugin never loads (silently: no tools, no capture). Pass it explicitly when in
> doubt:
>
> ```bash
> node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to
> ```
>
> Install into one profile only: two active profiles would both write the same
> `~/.dsh/memory-tree/memory.db`, and SQLite allows a single writer.

`--copy-to` copies `src/`, `docs/`, `package.json`, README files, LICENSE,
CHANGELOG into the profile and adds one entry to `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-memory-tree
      name: 'dsh-memory-tree'
      config: { enabled: true, /* ... */ }
```

The source checkout can then be moved or deleted. To paste the copy elsewhere:

```bash
node scripts/install.mjs --copy-to "D:\dsh-plugins\dsh-memory-tree"
# copies outside node_modules → the installer writes a shim with an absolute file URL
```

### B. Development checkout

```bash
node scripts/install.mjs
```

Writes `<profile>/dsh-memory-tree.plugin.mjs` (an ESM shim) that re-exports this
folder. Use it while iterating; the folder must stay where it is.

### C. npm / tarball

```bash
# on the machine that builds
npm pack                                  # dsh-memory-tree-0.1.0.tgz

# on the target machine
cd ~/.dsh/profiles/web
pnpm add "file:/path/to/dsh-memory-tree-0.1.0.tgz"
# then add the entry by name in cordis.patch.yml:
#   - insert:
#       - id: dsh-memory-tree
#         name: 'dsh-memory-tree'
```

Once published to npm, `pnpm add dsh-memory-tree` replaces the tarball.

## 2. Provide the embedding key (choose one)

| Method | How | Good for |
|---|---|---|
| Credentials file | `{"apiKey":"sk-..."}` at `$DSH_HOME/memory-tree/credentials.json` | normal desktop use |
| Environment variable | `MEMORY_TREE_API_KEY` before starting DSH | CI, shared machines, secrets managers |
| DSH credentials | `embedding.apiKeyEnv: MY_KEY_NAME` + a value in `~/.dsh/.credentials.yaml` | keeping every key in DSH's own store |

Never put a key into `cordis.patch.yml` or the repository: `node scripts/check-secrets.mjs` fails the build if you do.

Local-only setup (no key, no outbound network):

```yaml
config:
  embedding:
    preset: ollama          # http://127.0.0.1:11434/v1, bge-m3
    sendDimensions: false
```

## 3. Restart and verify

1. Restart DeepSeek Harness.
2. Ask the agent: `call mem_stats` → it must return a database path, model name and per-tier counts.
3. Chat two turns, then check that the hot file appeared and grew:

```bash
ls -l "$DSH_HOME/memory-tree"
# memory.db  memory.db-wal  memory/ (Markdown mirror)  credentials.json
```

4. Open a new session and ask something from the earlier conversation: the model
   should receive a `<memory-recall>` block (the transcript shows it as a
   collapsed system context message).

Inspect the store without starting DSH:

```bash
node scripts/inspect.mjs          # tier files, counts, spaces, newest docs, mirror files
node scripts/inspect.mjs --json   # machine-readable
```

## 4. Moving the memory itself

The whole brain is one directory:

```
$DSH_HOME/memory-tree/
├── memory.db          # hot tier
├── memory-warm.db     # warm tier (created by the first rotation)
├── memory-cold.db     # cold tier
├── memory/            # Markdown mirror (human-readable, git-friendly)
└── credentials.json   # optional; exclude it when copying to another person
```

Copy the directory to the new machine, **before** starting DSH. With the same
embedding model and dimensions the vectors stay comparable, so recall keeps
working without re-indexing.

Rules of thumb:

- **Never let two machines write the same SQLite file** (network shares, Dropbox,
  OneDrive). SQLite is single-writer; you will corrupt or block the file.
- One-way sync (rsync push) or `git` on the Markdown mirror only is safe.
- If you change `embedding.model` or `embedding.dimensions`, delete the tier
  files (or set a new `dataDir`): vectors from different models are not
  comparable.

## 5. Upgrade / uninstall

```bash
# upgrade: replace the folder, then re-run the installer (idempotent)
node scripts/install.mjs --copy-to

# uninstall (keeps the memory directory)
node scripts/install.mjs --uninstall
```

`--uninstall` removes the package copy, neutralizes the shim and deletes the
`cordis.patch.yml` entry (with a backup). Your `$DSH_HOME/memory-tree` data is
untouched.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mem_stats` missing from tools | plugin not loaded | check the patch entry id/name, restart DSH, look for load errors |
| `no embedding API key` in logs | key not found | put `credentials.json` in `$DSH_HOME/memory-tree/` or export `MEMORY_TREE_API_KEY` |
| `dsh-memory-tree needs Node 22.5+` | DSH started with an older Node | start DSH with its bundled runtime |
| recall is empty right after install | nothing captured yet | chat a few turns, or `mem_store` a note, then `mem_stats` |
| memories never become searchable | embedding failed | `mem_stats` shows `pending`; the plugin retries every 2 min, or run `mem_dream`/restart |
| old memories not found | they rotated into warm/cold and the query is short | increase `recall.maxNodes`, or set `storage.tiered: false` |
| cold file grows fast | vectors kept for cold docs | set `storage.dropColdVectors: true` (keyword-only recall for the archive) |
| `SQLITE_BUSY` | two writers (another agent + CLI) | avoid concurrent writes; `busy_timeout` is 5 s |
