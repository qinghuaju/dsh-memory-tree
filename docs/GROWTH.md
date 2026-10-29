# GitHub 可见度与 Star 增长策略

> 目标：让 dsh-memory-tree 成为 **DSH 生态的默认记忆底座**，并让非 DSH 用户也觉得这套思路值得一看。
> 前提：不刷星、不互赞、不群发。所有动作都围绕「真实可用 + 可验证」展开。

## 0. 先定位：你卖的到底是什么

一句话（README 首屏、GitHub description、所有帖子都用它）：

> **Long-term memory for DeepSeek Harness — an AST-indexed, tiered SQLite brain that survives sessions.**

三个卖点按重要性排序：

1. **补上了 DSH 最大的空缺**：官方没有跨会话记忆，社区插件多是"扁平向量 + LIKE"；本项目做了 AST 结构 + 分层文件 + 可解释打分。
2. **可验证**：`scripts/selftest.mjs`、`scripts/bench.mjs`、`scripts/check-secrets.mjs` 全部可复跑，数字写在 README 里。
3. **安全默认**：只读写本地、不对外发帖、召回内容按不可信资料处理——直接对撞"B 站自动回复事故"这类公众记忆。

## 1. 仓库即落地页（转化率最高的一环）

GitHub 上 80% 的 star 决策发生在 README 前 15 秒。按这个顺序排：

| 区块 | 内容 | 为什么要 |
|---|---|---|
| 顶部 | 一句英文定位 + badges（license / node / tests / npm / DSH） | 立刻可判断"是否与我有关" |
| Hero | 一张 8–12 秒 GIF：聊两轮 → 新会话问"上周那个方案" → `<memory-recall>` 出现 | 记忆类项目必须"看见它工作" |
| 30 秒 Quick start | 3 条命令 + key 放哪里 | 降低尝试门槛 |
| 对比表 | vs `CLAUDE.md`/`AGENTS.md`、vs 扁平向量 RAG、vs 托管记忆服务 | 让人知道"为什么不直接用现成的" |
| 架构图 | 一张 SVG（capture → AST → tiers → recall） | 技术用户会截图转发 |
| 基准表 | 1k/10k/30k 节点的召回 p50/p95 + 文件大小 | 把"会不会变慢"这个最大疑问提前杀死 |
| 原理摘要 | 5 行公式 + 链接到 PRINCIPLES.md | 显得不是 prompt 拼接 |
| FAQ | 10 个真实问题（密钥、迁移、多机、换模型、丢记忆） | 减少 issue，也利于搜索命中 |
| Roadmap | 勾选式阶段（L2 巩固 / L3 LoRA / MCP / 可视化） | 给潜在贡献者和 star 一个"未来理由" |

细节：

- **英文为主、中文并列**：`README.md` 英文，`README.zh.md` 中文，互链；中文社区传播时直接发中文版链接。
- **目录锚点**：长 README 必须有 TOC；GitHub 侧边栏可导航。
- **每个数字都能复跑**：写清 `node scripts/bench.mjs --sizes 1000,10000,30000`，避免"PPT 性能"。
- **截图代替形容词**：`mem_stats` 输出、tier 文件列表、召回块渲染各来一张。

## 2. 可发现性（让搜索和推荐找得到你）

1. **仓库名**：`dsh-memory-tree`（含 dsh 关键词，且语义明确）。
2. **Description**：`AST-indexed long-term memory for DeepSeek Harness: SQLite + embeddings, tiered files, cross-session recall.`
3. **Topics（20 个以内，全部用上）**：
   `dsh` `deepseek-harness` `deepseek` `agent-memory` `long-term-memory` `memory` `rag` `sqlite` `nodejs` `embeddings` `vector-search` `ast` `mcp` `local-first` `privacy` `ai-agents` `llm` `knowledge-management` `semantic-search` `plugin`
4. **awesome 列表**：给 `awesome-deepseek`、`awesome-ai-agents`、`awesome-rag`、`awesome-local-ai` 提 PR（每个列表的收录标准不同，先读 CONTRIBUTING）。
5. **插件市场**：DSH 社区插件的收录入口提交（先确认规则），并在 README 放"Install from market"小节。
6. **npm**：发布后 `npm keywords` 与 topics 对齐；npm 页面会带 README。

## 3. 发布节奏（30 天）

| 周 | 动作 | 产出 |
|---|---|---|
| W1 | 仓库上线（README/GIF/CI/issue 模板/LICENSE/SECURITY） | 可被 star 的最小完整形态 |
| W1 | 在 DSH 社区/插件市场提交 | 第一批真实用户 |
| W2 | 技术长文（中文）：*"给 Agent 装一个不会断片的海马体：AST + 分层 SQLite 记忆"* | 知乎/掘金/V2EX 各发一版，链回仓库 |
| W2 | 英文短文（dev.to / Hashnode）：*"Why your coding agent forgets, and a 300-line fix"* | 覆盖英文搜索 |
| W3 | 视频：3 分钟演示（B 站 + YouTube），标题带"DSH 记忆" | 你的现有受众直接转化 |
| W3 | Reddit `r/LocalLLaMA` + `r/LLMDevs`：只发"我遇到的问题 + 数据 + 仓库"，不发广告腔 | 海外第一波 |
| W4 | Hacker News `Show HN`（周二/周三 08:00 PT 最佳）；标题：`Show HN: Long-term memory for a coding agent, in one SQLite file` | 冲首页 |
| W4 | 汇总反馈 → 发 v0.2（至少一个社区要求的特性） | 二次曝光理由 |

发帖模板（避免被当成 spam）：

```
问题（我自己的真实场景，1–2 句）
→ 我试过的方案为什么不够（列表/向量/CLAUDE.md）
→ 我做了什么（3 条要点）
→ 数据（召回延迟、文件大小、测试数）
→ 怎么试（一条命令）
→ 我想要什么反馈（具体问题，不是"求 star"）
```

## 4. 内容钩子（决定传播力）

按"可截图、可复述、有冲突"筛选：

1. **"大肥鱼断片"故事**：Agent 升级后旧记忆全丢，像"妈妈给女儿留信"——用它做开头，比任何架构图都抓人。结尾给解法（分层文件 + 可继承记忆库）。
2. **对比实验**：同一个问题，`CLAUDE.md` 全量加载 vs 本插件召回，给出 token 数与命中率。
3. **"不用电的显示屏"跨学科记忆**：把真实对话（光遗传学 → 生物显示）作为 demo 语料，展示"一个月前的灵感被自动召回"。这是你独有的素材。
4. **基准图**：一张折线图（节点数 vs 召回延迟），标注"10k 节点 57ms，热层文件不随年龄增长"。
5. **安全默认**：明确写"不会自动评论/发帖/发邮件"，对照现实事故。

## 5. 信任信号（决定 star 后是否留下）

- CI：GitHub Actions 跑 `selftest` + `dryrun` + `check-secrets`（badge 放 README 顶部）；
- `SECURITY.md`：密钥处理、数据边界、漏洞上报方式；
- `CONTRIBUTING.md`：如何加 embedding provider、如何加测试；
- `good first issue`：至少 5 个（加 provider、加 i18n、加 README 截图、加 Windows 路径测试、加 sqlite-vec 后端）；
- `CHANGELOG.md` + SemVer + tag/release notes；
- Issue/PR 模板（bug 模板要求贴 `mem_stats` 输出，减少往返）。

## 6. 社区运营（把 star 变成贡献者）

- 用 **GitHub Discussions** 开三个版块：`Show your memory`（用户晒召回）、`Ideas`、`Help`；
- 每月一条 "What got recalled this month" 帖子（匿名化），既是内容也是社会证明；
- 对每个 issue 24 小时内响应（前 3 个月尤其重要）；
- 给早期用户一个 `CONTRIBUTORS.md` 名单；
- 版本发布时 @ 提到贡献者。

## 7. 度量与迭代

| 指标 | 工具 | 目标（首月） |
|---|---|---|
| star 增速 | GitHub insights | 首周 50+，首月 200+（有 HN 首页则 500+） |
| npm 下载 | npm stats | 与 star 比例 ≥ 1:5 |
| issue 首响 | 手动 | < 24h |
| README 跳出 | 无法直接测，用 issue 提问质量判断 | 减少"怎么装"类问题 |

每两周做一次小实验：换 README 首屏标题、换 GIF 顺序、换 Quick start 命令数，保留转化更好的版本（用 star 增速与 clone 数近似）。

## 8. 不要做的事

- 不买 star、不互赞、不进"star 互刷群"——GitHub 会降权，且毁掉技术信誉；
- 不在别人 issue/视频下刷"我的项目"；
- 不承诺"永久记忆/永不遗忘"这种做不到的话；
- 不隐藏限制（当前是全量余弦扫描、无 L2 巩固、单写入者）——写清楚反而增加信任。

## 9. 一页 checklist（发布当天）

- [ ] 英文 README 首屏 15 秒能看懂 + GIF 能播放
- [ ] 中文 README 与英文互链
- [ ] `bench.mjs` 数字与 README 一致
- [ ] CI 绿 + badge 正确
- [ ] topics / description / social preview 图（1280×640）
- [ ] LICENSE、SECURITY、CONTRIBUTING、issue 模板
- [ ] release v0.1.0 + tag + release notes
- [ ] 至少 3 个 good first issue
- [ ] 一条 3 分钟演示视频
- [ ] 首发帖（中文 1 篇 + 英文 1 篇）准备好，错峰发布
