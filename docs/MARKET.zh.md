# 上架 DSH 插件市场

[English](MARKET.md) | 中文

在 DSH 0.2.1-rc.3 里，市场是**可选**的：宿主带读取器与 Discover 界面，但只有 profile 加载了
`plugin-market` 服务、并且用户**主动添加索引 URL** 时才会工作——**默认没有任何官方索引**。
所以“上架”分两步：把格式 1 的索引发布到稳定地址；用户添加该 URL（或将索引纳入官方列表）。

---

## 1. 市场读什么

市场索引是一份 JSON，由 `@deepseek-ai/dsh-plugin-market-index` 校验：

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
      "icon": "icon.svg",
      "homepage": "https://github.com/qinghuaju/dsh-memory-tree",
      "repository": { "url": "https://github.com/qinghuaju/dsh-memory-tree", "directory": "." },
      "metadata": { "category": "memory", "keywords": ["memory", "sqlite", "embedding"] },
      "versions": [
        {
          "version": "0.2.3",
          "publishTimestamp": 1793000000,
          "source": {
            "type": "git",
            "url": "https://github.com/qinghuaju/dsh-memory-tree",
            "commit": "<40 位小写 commit>",
            "path": "."
          },
          "engines": { "dsh": ">=0.2.1-rc.3" }
        }
      ]
    }
  ]
}
```

校验规则（要点）：

- `format` 必须是 `1`；`title.en` 必填，其它语言可选；
- 插件 `name` 必须是合法 npm 包名，且不允许重复；
- `version` 必须是精确 SemVer；`publishTimestamp` 是 Unix 秒整数；
- `source.type: "npm"` → 安装 `name@version`；可选 `registry` 必须是 https；
- `source.type: "git"` → **规范 https URL**（至少两段路径）+ **40 位小写 commit**；`path` 为相对目录；
- `icon` 可相对索引 URL，或 32 KiB 以内的 `data:` URL；
- 索引 URL 不得带账号密码或 fragment。

本地可用 `scripts/check-market.mjs` 校验，`scripts/market-index.mjs` 生成。

---

## 2. 生成并托管

```bash
# 发布提交完成之后：
node scripts/market-index.mjs --owner qinghuaju --repo dsh-memory-tree --commit <sha> --npm
node scripts/check-market.mjs
```

托管到稳定 https 地址，例如 GitHub Pages：

```
https://qinghuaju.github.io/dsh-memory-tree/market/index.json
```

或 raw：

```
https://raw.githubusercontent.com/<owner>/dsh-memory-tree/main/market/index.json
```

把 `icon` 一起放（`market/icon.svg`），相对路径即可解析。

---

## 3. 在 DSH 里添加索引

1. profile 必须加载市场服务（仅带 `@deepseek-ai/dsh-plugin-market-bundle` 的构建可用）：

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "@deepseek-ai/dsh-plugin-market-bundle"
   ] } }
   ```

2. 重启 DSH → **设置 → 插件 → Discover**，或调用宿主接口：

   ```
   pluginMarket.setIndexes(["https://qinghuaju.github.io/dsh-memory-tree/market/index.json"])
   pluginMarket.listIndexes()
   ```

3. 列表中会出现插件与版本；**安装**会解析为
   `git+https://github.com/qinghuaju/dsh-memory-tree.git#<commit>&path:/.`，走 `pluginManager.installBundle`。

若你的 DSH 构建没有市场 bundle，这份 JSON 仍可用于 CI 校验与代理读取，等市场可用再接。

---

## 4. “官方市场”现状

- DSH 0.2.1-rc.3 的官方 profile **没有配置任何索引**，目前不存在可直接提交的官方目录；
- 现阶段的“官方路径”是：先发布 npm + GitHub，然后向
  [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 提 PR/issue，
  申请把索引加入官方精选列表或文档中的社区索引；
- 在此之前，npm + 自托管索引是等效可用的：用户只需添加一个 URL。

## 5. 发布检查清单

- [ ] `selftest`、`dryrun`、`check-secrets` 全部通过
- [ ] 版本号、`CHANGELOG.md` 更新，打 tag
- [ ] 用发布 commit 重新生成 `market/index.json` 并通过校验
- [ ] 在 profile 中添加索引并端到端验证安装
- [ ] README 里的链接指向公开仓库
