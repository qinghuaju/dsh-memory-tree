# Listing on the DSH plugin market

English | [中文](MARKET.zh.md)

The market is **opt-in** in DSH 0.2.1-rc.3: the host ships the reader and the Discover UI, but
profiles load the `plugin-market` service only when its bundle is present, and **no index URL is
configured by default**. Listing therefore means: publish a format-1 index somewhere stable, then
let users add that URL (or, later, get the index into a curated list).

---

## 1. What the market reads

A market index is one JSON document, validated by `@deepseek-ai/dsh-plugin-market-index`:

```jsonc
{
  "format": 1,
  "title": { "en": "DSH Memory Tree", "zh": "DSH 记忆树" },
  "description": { "en": "...", "zh": "..." },
  "metadata": {
    "categories": { "memory": { "title": { "en": "Memory", "zh": "记忆" } } }
  },
  "plugins": [
    {
      "name": "dsh-memory-tree",
      "title": { "en": "Memory Tree", "zh": "记忆树" },
      "description": { "en": "...", "zh": "..." },
      "icon": "icon.svg",                 // relative to the index URL, or a data: URL ≤ 32 KiB
      "homepage": "https://github.com/qinghuaju/dsh-memory-tree",
      "repository": { "url": "https://github.com/qinghuaju/dsh-memory-tree", "directory": "." },
      "metadata": { "category": "memory", "keywords": ["memory", "sqlite", "embedding"] },
      "versions": [
        {
          "version": "0.2.3",            // exact SemVer
          "publishTimestamp": 1793000000, // Unix seconds
          "source": {
            "type": "git",                // or "npm"
            "url": "https://github.com/qinghuaju/dsh-memory-tree",
            "commit": "<lowercase 40-hex commit>",
            "path": "."                   // optional package directory
          },
          "engines": { "dsh": ">=0.2.1-rc.3" }
        }
      ]
    }
  ]
}
```

Rules the validator enforces (short list):

- `format` must be exactly `1`; `title.en` is mandatory (other languages optional).
- plugin `name` must be a valid npm package name; duplicates are refused.
- `version` exact SemVer; `publishTimestamp` an integer Unix-seconds value.
- `source.type: "npm"` installs `name@version`; optional `registry` must be https.
- `source.type: "git"` requires a **canonical https URL with at least two path segments** and a
  **lowercase 40-hex commit**; `path` is a relative directory without `.`/`..`.
- `icon` may be relative to the index URL (https) or an inline `data:` URL ≤ 32 KiB.
- No index URL may contain credentials or a fragment.

`scripts/check-market.mjs` mirrors these rules locally; `scripts/market-index.mjs` generates the
document from `package.json` + a commit SHA.

---

## 2. Generate and host it

```bash
# after the release commit exists:
node scripts/market-index.mjs --owner qinghuaju --repo dsh-memory-tree --commit <sha> --npm
node scripts/check-market.mjs
```

Host `market/index.json` at a stable https URL, e.g. GitHub Pages:

```
https://qinghuaju.github.io/dsh-memory-tree/market/index.json
```

or the raw file:

```
https://raw.githubusercontent.com/<owner>/dsh-memory-tree/main/market/index.json
```

Keep the `icon` next to it (`market/icon.svg`) so it resolves relatively.

---

## 3. Add the index in DSH

1. The profile must load the market service. Add the market bundle to your profile (only builds
   that ship `@deepseek-ai/dsh-plugin-market-bundle` can do this):

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "@deepseek-ai/dsh-plugin-market-bundle"
   ] } }
   ```

2. Restart DSH → **Settings → Plugins → Discover**, or call the host API:

   ```
   pluginMarket.setIndexes(["https://qinghuaju.github.io/dsh-memory-tree/market/index.json"])
   pluginMarket.listIndexes()
   ```

3. The listing shows the plugin with its versions; **Install** resolves to
   `git+https://github.com/qinghuaju/dsh-memory-tree.git#<commit>&path:/.` and goes through
   `pluginManager.installBundle`.

If your DSH build does not ship the market bundle, the same JSON is still useful: agents can read
it, and CI can validate it, until the market becomes available.

---

## 4. "Official market" status

- Shipped DSH 0.2.1-rc.3 profiles configure **no** index: there is no default official catalog to
  submit to yet.
- The official route today is: publish the package (npm + GitHub), then open a PR/issue against
  [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) proposing that
  your index be added to the curated/default list (or to their docs as a community index).
- Until then, npm presence + a self-hosted index is the functional equivalent: users add one URL
  and get install/update through the same mechanism.

## 5. Release checklist

- [ ] `node scripts/selftest.mjs`, `dryrun-plugin.mjs`, `check-secrets.mjs` green
- [ ] version bumped, `CHANGELOG.md` updated, tag pushed
- [ ] `market/index.json` regenerated with the release commit and validated
- [ ] index URL added to the profile and installation verified end-to-end
- [ ] README links point at the public repository
