# 发布清单 / Publishing checklist

> ⚠️ **发布前必须经过仓库所有者审核。** 本文件只描述步骤，不代表已执行。
> 任何 `git push`、GitHub 仓库创建、npm publish、DSH 插件市场投稿，都要等 owner 明确同意后由 owner 执行或授权执行。

## 0. 原则

- **密钥永不出仓库**：embedding key 只放 `$DSH_HOME/memory-tree/credentials.json` 或环境变量；
- **账号密码不落盘**：不要在任何脚本、文档、commit message 里写 GitHub 账号密码。用 `gh auth login`（浏览器/PAT）或 SSH key；
- **数据不发布**：`data/`、`*.db`、`memory/` 镜像、`credentials.json` 都已在 `.gitignore`；
- **先审后发**：owner 看过 diff、跑过验收，再执行发布动作。

## 1. 发布前检查（每次）

```bash
node scripts/selftest.mjs          # 离线全绿（40 checks）
node scripts/selftest.mjs --live   # 真实 embedding 全绿（42 checks，需要 key）
node scripts/dryrun-plugin.mjs     # 插件挂载全绿（26 checks）
node scripts/check-secrets.mjs     # 必须 clean
node scripts/check-market.mjs      # 索引存在时校验 format 1
node scripts/bench.mjs --sizes 1000,10000,30000   # README 数字必须来自这次运行
node --check src/plugin.mjs        # 语法
git status --short                 # 确认没有意外文件
```

人工确认：

- [ ] `git ls-files` 里没有 `node_modules/`、`data/`、`*.db`、`credentials.json`、`.env`、`pollinationsApi.md`；
- [ ] `git log -p` 里没有历史密钥（如果曾提交过，必须换 key，而不是只删文件）；
- [ ] README 的安装步骤在一台“干净”机器上可执行（至少 read-through 一遍）；
- [ ] 版本号已更新（`package.json` = 0.3.0），CHANGELOG 有对应段落；
- [ ] CI 在目标仓库上跑过一次并且是绿的（`.github/workflows/ci.yml`）。

## 1.5 发布素材（决定首屏转化）

按 [GROWTH.md](GROWTH.md) 的清单准备，最少要有：

- [ ] 8–12 秒 GIF：两轮对话 → 新会话 → `<memory-recall>` 出现；
- [ ] 1280×640 的 social preview 图（GitHub Settings → Social preview）；
- [ ] `mem_stats` 输出截图（体现 tiers / size）；
- [ ] README 里的基准表与 `bench.mjs` 输出一致；
- [ ] 3 分钟演示视频（B 站 + YouTube），标题含 "DSH 记忆" / "agent memory"。


## 2. 首次发布到 GitHub

前提：

- **本机需要先安装 Git**（当前机器上没有 `git` 命令，`git --version` 会失败），以及 GitHub CLI（`gh`）或 SSH key；
- owner 已登录（`gh auth status` 通过），且同意创建公开仓库。

```bash
# 在 D:\dshMemo 里
git init
git add .
git commit -m "feat: dsh-memory-tree 0.2.0 (AST + tiered SQLite memory for DSH)"
# 由 owner 执行或授权：
gh repo create dsh-memory-tree --source=. --remote=origin --push   # 需要私有就先不加 --public
```

提交身份建议显式设置，避免把私人邮箱写进公开历史：

```bash
git config user.name  "dsh-memory-tree"
git config user.email "noreply@users.noreply.github.com"
```

注意：

- 如果 `pollinationsApi.md` 是第三方文档、不适合随仓库公开，先移出仓库或改成链接；
- 仓库描述建议：`Long-term memory for DeepSeek Harness: AST soft-decision-tree + embeddings over SQLite`；
- Topics：`dsh`、`dsh-plugin`、`deepseek-harness`、`memory`、`rag`、`sqlite`、`embedding`。

## 3. 发布到 npm（可选，插件市场通常需要）

```bash
npm login                       # owner 交互登录，不要把 token 写进仓库
npm pack --dry-run              # 检查打包内容（应只有 src/ docs/ README LICENSE）
npm publish --access public     # 由 owner 执行
```

`package.json` 已包含 `files` 白名单，`peerDependencies` 指向 DSH 运行时提供的包，因此安装到 profile 时不会重复装一份 DSH 内核。

## 4. 分享到 DSH 插件市场

不同版本的 DSH 市场（如 `@linxin666/dsh-client-ui-market`）收录方式可能不同。**投稿前先确认当前市场的收录规则**，不要凭猜测提交。建议顺序：

1. 在 DSH 的「插件市场 / 社区插件」界面查看是否有 “Submit plugin / 提交插件” 入口；
2. 若要求仓库带 `dsh-plugin` topic 或 `package.json` 里的 `dsh` 字段，按提示补；
3. 准备一段中文 + 英文简介、截图（`mem_stats` 输出即可）、以及"默认关闭自动注入"的配置示例，降低他人误用风险（这是从 B 站自动回复事故里学到的教训：**默认行为要克制**）；
4. 由 owner 提交，保留审核记录。

市场页面的文案、截图、演示素材与推广节奏见 **[GROWTH.md](GROWTH.md)**（首屏结构、topics、30 天发布节奏、内容钩子、信任信号、30 天 checklist）。

## 5. 版本与变更记录

- 采用 SemVer：`0.x` 阶段允许 schema 小改动，但**向量维度/模型变更必须写进 CHANGELOG 并提示重建索引**；
- 建议维护 `CHANGELOG.md`：

```md
## 0.2.0
### Added
- 分层 SQLite（hot/warm/cold）+ 按年龄轮转 + 跨层召回
- FTS5 关键词索引（CJK bigram）、向量缓存、写入 O(N²) 修复
- mem_rotate、compact()（WAL→DELETE→VACUUM）
- --copy-to 部署模式、基准脚本、中英文档与 CI
### Changed
- mem_stats 输出分层统计；轮转直达目标层
### Fixed
- 纯 RRF 打分被使用频次压过相关问题
```

## 6. 出问题怎么回滚

| 场景 | 动作 |
|---|---|
| 插件导致 DSH 启动异常 | 删 `profiles/web/dsh-memory-tree.plugin.mjs`，从 `cordis.patch.yml` 删除 `dsh-memory-tree` 条目（或用备份 `.bak-memory-tree-*` 覆盖），重启 |
| 密钥误提交 | 立即在供应商后台吊销并换新 key；`git filter-repo` 清历史；force push 后通知协作者重新 clone |
| 数据库损坏 | `memory.db` 可直接删除重建（记忆丢失但 DSH 不受影响）；原文在 `memory/*.md` 镜像里 |
| 换 embedding 模型 | 备份后删除 `memory.db`（或只清 `vectors`/`embed_cache` 表），重新索引 |
