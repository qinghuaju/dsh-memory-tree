## What changed

<!-- one paragraph, user-visible effect first -->

## Why

<!-- the problem this solves; link an issue if there is one -->

## Verification

<!-- paste the relevant output -->

```
node scripts/selftest.mjs
node scripts/bench.mjs                   # only if the change affects latency/size
node scripts/check-secrets.mjs
```

- [ ] `node scripts/selftest.mjs` passes
- [ ] `node scripts/check-secrets.mjs` is clean
- [ ] README / README.zh.md updated when config or behaviour changed
- [ ] CHANGELOG.md entry added
- [ ] no new dependency in `src/engine/`
