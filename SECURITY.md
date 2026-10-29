# Security policy

## Reporting

Open a private security advisory on the GitHub repository (Security → Advisories →
"Report a vulnerability"). Please do not file a public issue for anything that could
expose credentials or memory contents. Expect an acknowledgement within 72 hours.

## What this plugin stores

Everything lives under `$DSH_HOME/memory-tree/` on the local machine:

| File | Contents | Sensitivity |
|---|---|---|
| `memory.db`, `memory-warm.db`, `memory-cold.db` | captured conversation text, AST node text, embeddings, audit rows | same as your chat history |
| `memory/**/*.md` | human-readable mirror of every stored document | same |
| `credentials.json` | embedding API key | secret |
| `*.db-wal`, `*.db-shm` | SQLite journals | same as the databases |

Nothing is uploaded. The only outbound traffic is the text sent to the configured
embedding endpoint (`/v1/embeddings`), which includes captured conversation content.

## Key handling

- Keys are read, in order, from: plugin `embedding.apiKey` → `credentials.json` →
  `MEMORY_TREE_API_KEY` (or `embedding.apiKeyEnv`) → `apiKeyEnvFallbacks`.
- Keys are never written to logs, prompts, recall blocks, `cordis.patch.yml`, or the
  Markdown mirror.
- `scripts/check-secrets.mjs` scans the repository for key-like material and is part of CI.
- If a key leaks: revoke it at the provider, rotate it, and rotate the credential file.
  Removing a file from a Git commit history is not enough by itself.

## Prompt-injection surface

Memory content is treated as untrusted data:

- recalled blocks are wrapped in `<memory-recall>` and any embedded frame tags are escaped;
- the system prompt states the block is reference material, not instructions;
- injected messages are tagged `source.kind = plugin`, `form = recall`, and capture skips
  plugin-sourced messages so memory never records itself;
- tools that write memory (`mem_store`) are local and never push content anywhere.

A malicious document can still influence the model's answer — the mitigation is that the
model is told to prefer the current request and to cite node indices, not a guarantee.

## What the plugin will never do

- post, comment, email, or DM on your behalf;
- call arbitrary URLs (only the configured embedding endpoint);
- read files outside `$DSH_HOME/memory-tree/` except the Markdown files you explicitly
  index with `scripts/demo.mjs`;
- execute shell commands.

## Supported versions

Security fixes land on `main` and are tagged with a patch release. Pre-1.0, only the
latest minor receives fixes.
