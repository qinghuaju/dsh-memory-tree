# Codex integration alongside DSH

The DSH plugin and the Codex adapter share the same engine. Codex gets five MCP
tools and lifecycle hooks for automatic recall and capture. Use the same data
directory, embedding configuration and project path to share memory, or separate
directories to isolate it. See [中文完整说明](CODEX.zh.md).

## Install

Requires Node >= 22.5 and a local Codex client supporting `UserPromptSubmit`,
`Stop`, and `SessionStart` hooks.

```bash
npm ci
node scripts/install-codex.mjs --dry-run
node scripts/install-codex.mjs
```

The installer backs up and merges entries into `$CODEX_HOME/config.toml` and
`hooks.json` (default `~/.codex`), preserving unrelated settings. It is idempotent
and refuses to overwrite an unmanaged `mcp_servers.memory_tree`. The dry-run
prints only generated configuration, never existing settings or secrets.
The MCP `env_vars` entry forwards the configured embedding credential environment
variable names; secret values are never written into the Codex configuration.

Hooks run synchronously by default for compatibility with clients that skip async
hooks (including Codex CLI 0.144.6). Capture waits for indexing after the reply.
If your client supports background hooks, reinstall with `--async-hooks` and
review the changed definitions. `--sync-hooks` explicitly restores the default.

Restart Codex, then review and trust the three new Memory Tree hooks in `/hooks`.
Codex requires trust for new or changed non-managed hooks. The installer does not
bypass this requirement or override an explicitly disabled hooks feature.
Validate the automatic flow in the actual desktop/CLI version you use; UI entry
points can differ. MCP tools work independently of hook trust.

For project-only installation:

```bash
node scripts/install-codex.mjs --project /absolute/project/root
```

Use either global or project installation for a given project, not both. Project
configuration must be trusted. The generated commands use absolute checkout and
Node paths: rerun the installer after moving the checkout or replacing that Node.

## Shared configuration

The default directory remains `$DSH_HOME/memory-tree` (usually
`~/.dsh/memory-tree`). No manual data migration is needed. Schema v1 upgrades in
place to v2 by adding a turn-ID lookup index; document/vector layouts stay intact. Override with
`MEMORY_TREE_DATA_DIR` or:

```bash
node scripts/install-codex.mjs --data-dir /absolute/shared-memory
```

Set the DSH plugin's `dataDir` to the same directory. Both read its `config.json`
and `credentials.json`. Keep the embedding model and dimensions identical,
including any overrides in DSH's patch; the runtime rejects incompatible model
identities. Select a fresh directory and re-index source text to change models.

Existing `capture`, `recall`, `storage` and `tools` settings apply. For example,
`capture.enabled: false` disables automatic recording, `recall.autoInject: false`
disables automatic recall, and `tools.allowStore/allowDream/allowRotate` hide the
respective tools. `enabled: false` disables the adapter. Credentials and embedding
providers are unchanged. Ollama can run locally; cloud embedding sends text to
the configured endpoint. `embedding.fake: true` is for offline tests, not a
quality substitute for semantic embeddings. The installer never provisions keys.

## Lifecycle and boundaries

- `UserPromptSubmit`: redact and buffer the user's text, recall using the event's
  `cwd`, and return a bounded, untrusted `<memory-recall>` in `additionalContext`.
  Recall errors/timeouts return `{}` and never block the conversation.
  The installed hook timeout adds two seconds to `recall.timeoutMs` for process
  startup (minimum five seconds); rerun the installer after changing this budget.
- `Stop`: combine the buffered prompt(s) with
  `last_assistant_message`, persist a retryable capture, and index it. The first
  completed reply for a turn wins; duplicate Stop callbacks are idempotent.
- `SessionStart`: retry unfinished captures. Relevant recall in a
  new chat happens when its first prompt is submitted.

`--async-hooks` makes Stop and SessionStart run in the background.

This captures **user text and the last assistant message supplied to Stop**.
Intermediate commentary, tool output, images and interrupted replies without a
Stop event are not captured. No internal transcript parsing or historical chat
import is performed. `includeAssistant: false` stores only prompts. Excluded
sessions/cwds skip both automatic capture and recall; short prompts follow
`capture.minChars`.

`codex-capture.db` contains redacted pending turns and completion receipts.
Receipts no longer contain message bodies. Waiting incomplete turns and receipts
expire after seven days; completed captures awaiting retry are kept. Background
hooks may be cancelled on session exit, so durable queuing and idempotent indexing
are essential.

## MCP tools

| Tool | Parameters |
|---|---|
| `mem_recall` | `query`, **`cwd`**; optional `scope`, `limit`, `path` |
| `mem_store` | `content`, **`cwd`**; optional `title`, `scope`, `importance` |
| `mem_stats` | None; reports the configured database's overall statistics |
| `mem_dream` | **`cwd`**; optional `scope` |
| `mem_rotate` | None; rotates the entire configured database |

`cwd` must be the current task's absolute project path. A global MCP server's
startup directory is never silently used as the project. Distinct worktrees or
machine paths remain distinct project spaces, as in DSH.

For tools only, omit the hooks and configure:

```toml
[mcp_servers.memory_tree]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/dsh-memory-tree/src/mcp/server.mjs", "--data-dir", "/absolute/shared-memory"]
# Use the environment variable names from your embedding configuration.
env_vars = ["OPENAI_API_KEY"]
startup_timeout_sec = 15
tool_timeout_sec = 600
```

## Concurrent clients

Both updated adapters use an OS-released SQLite transaction mutex in
`memory.db.lock.db` to serialize whole engine operations, including tier rotation.
An occupied lock costs automatic recall only its configured timeout. The engine
still lives in isolated child processes. Diagnostics go to `plugin.log`.

Upgrade **both** clients; old DSH copies do not participate in the mutex. Rerun
DSH's `--copy-to` installer if applicable. Custom programs calling the raw engine
must coordinate their own concurrency or use `createEngineService` instead.
This is single-machine sharing, not multi-machine/network-filesystem sync.

## Verify and remove

```bash
npm run selftest
npm run test:codex
npm run test:compat
node scripts/check-secrets.mjs
```

Tests use temporary directories and fake embeddings, without real conversation
data, credentials, or personal Codex configuration. After installing, call
`mem_stats`, save a decision in project A, recall it from a new chat in A and
verify project B cannot see it. Verify DSH can recall the Codex decision too.

```bash
node scripts/install-codex.mjs --uninstall
# Or use the same project scope used during installation:
node scripts/install-codex.mjs --project /absolute/project/root --uninstall
```

Uninstall preserves memory, backups and unrelated configuration.

Protocol references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[Codex Hooks](https://learn.chatgpt.com/docs/hooks).
