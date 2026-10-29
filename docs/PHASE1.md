# Phase 1 计划与验收 / Phase 1 scope

## 1. Phase 1 目标（本仓库已实现）

> 用 AST 软决策树 + embedding 矢量化标注 + SQLite 持久化，实现 DSH 的跨会话长期记忆：
> 会话消息自动落盘、按项目隔离、可全局共享；新一轮任务里能自动/手动召回；不阻塞主循环、不泄露密钥。

具体交付：

| # | 交付物 | 状态 |
|---|---|---|
| 1 | `node:sqlite` 存储 + schema 迁移 | ✅ |
| 2 | AST 解析（标题/编号/项目符号/段落）+ 唯一路径 | ✅ |
| 3 | embedding 客户端（OpenAI 兼容、批处理、重试、缓存、fake 模式） | ✅ |
| 4 | 向量扫描 + FTS5 关键词（CJK bigram）+ 混合打分 + 扩散 + 先验 + 多样性 | ✅ |
| 5 | `<memory-recall>` 渲染、转义、预算控制 | ✅ |
| 6 | 会话捕获缓冲（合流、去重、失败重试、串行 flush） | ✅ |
| 7 | `agent/pre-step` 自动注入（step 1、超时跳过、每轮去重、故障冷却） | ✅ |
| 8 | 工具 `mem_recall` / `mem_store` / `mem_stats` / `mem_dream` / `mem_rotate` | ✅ |
| 9 | 项目空间 + 全局空间；按 cwd 解析项目根 | ✅ |
| 10 | Markdown 镜像（人类可读、可迁移） | ✅ |
| 11 | 分层存储：hot/warm/cold 三个 SQLite 文件 + 按年龄轮转 + 跨层召回 | ✅ |
| 12 | 体积控制：embedding 缓存/召回日志裁剪、`compact()`（WAL→DELETE→VACUUM） | ✅ |
| 13 | 安装器（开发 shim / `--copy-to` 包安装，幂等、备份、卸载） | ✅ |
| 14 | 离线自测 + 真实 API 测试 + 插件 dry-run + 基准脚本 | ✅ |
| 15 | 文档（中英 README、架构、原理、部署、发布、增长策略）+ CI + issue/PR 模板 | ✅ |

## 2. 非目标（明确不在 Phase 1）

- 睡眠期巩固流水线（摘要、合并、抽象成规则）；
- 记忆权重化 / LoRA 微调；
- 多机同步、冲突解决（CRDT / 版本向量）；
- 向量库服务化（Qdrant / Milvus / sqlite-vec）；
- 前端可视化（记忆图谱）。

## 3. 验收标准

```bash
# 1. 离线：AST / 索引 / 召回 / 去重 / 分层轮转 / 失败恢复
node scripts/selftest.mjs
# 期望：40 passed, 0 failed

# 2. 真实 embedding（需要 key）
node scripts/selftest.mjs --live
# 期望：42 passed, 0 failed

# 3. 插件挂载（桩上下文，需要本机装有 DSH 的 @deepseek-ai 包）
node scripts/dryrun-plugin.mjs
# 期望：23 passed, 0 failed（工具/捕获/跨会话注入/不重复注入/持久化过滤/卸载）

# 4. 基准（写 README 数字用）
node scripts/bench.mjs --sizes 1000,10000,30000

# 5. 安装（幂等）
node scripts/install.mjs --dry-run
node scripts/install.mjs --copy-to     # 已安装则输出 already installed

# 6. 真实 DSH 内验证（重启后）
#    让 Agent 调 mem_stats → 应返回 dbPath、模型、各层计数
#    随便聊两轮 → $DSH_HOME/memory-tree/memory.db 出现 documents/nodes
#    新开会话问“之前讨论过的 X” → 应看到 <memory-recall> 注入
#    改 storage.hotDays=0 后调用 mem_rotate → 出现 memory-warm.db / memory-cold.db
```

质量门槛（发布前自查）：

- [ ] `node --check` 全部通过（ESM 语法）；
- [ ] 自测与 dry-run 全绿；
- [ ] 仓库内 `grep` 不到任何真实 key（见 `docs/PUBLISHING.md`）；
- [ ] 未安装插件的 DSH 不受影响（安装/卸载可逆）。

## 4. 配置参考（完整）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | `$DSH_HOME/memory-tree` | 数据目录 |
| `dbPath` | `<dataDir>/memory.db` | 数据库路径 |
| `logging.level` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `embedding.preset` | `pollinations` | `pollinations`/`dashscope`/`openai`/`ollama`/`custom` |
| `embedding.baseUrl` | 预设 | 覆盖 endpoint（OpenAI 兼容根路径，自动补 `/embeddings`） |
| `embedding.model` | 预设 | 模型 id |
| `embedding.dimensions` | `1024` | 维度；换维度需重建索引 |
| `embedding.sendDimensions` | `true` | 是否发送 `dimensions` 字段（Ollama 建议 false） |
| `embedding.apiKeyEnv` | `MEMORY_TREE_API_KEY` | 凭据引用名（DSH credentials 可解析） |
| `embedding.apiKeyEnvFallbacks` | `["POLLINATIONS_API_KEY"]` | 备用环境变量 |
| `embedding.apiKey` | 空 | 直接写 key（不推荐；`role=secret`） |
| `embedding.credentialsFile` | `<dataDir>/credentials.json` | `{"apiKey":"..."}` |
| `embedding.batchSize` | `16` | 单次请求条数（上限 32） |
| `embedding.timeoutMs` | `30000` | 单请求超时 |
| `embedding.maxRetries` | `2` | 429/5xx/网络错误重试次数 |
| `embedding.maxInputChars` | `2000` | 单条输入截断长度 |
| `embedding.fake` | `false` | 离线确定性 embedder |
| `capture.enabled` | `true` | 是否捕获会话 |
| `capture.minChars` | `8` | 最小捕获长度（中文短消息友好；更短的“好了/继续”不落盘） |
| `capture.maxChars` | `40000` | 单次交换最大长度 |
| `capture.includeAssistant` | `true` | 是否包含助手消息 |
| `capture.flushIdleMs` | `1500` | 空闲 flush 延迟 |
| `capture.maxBufferedMessages` | `60` | 单会话缓冲上限 |
| `capture.excludeSessions` | `[]` | 排除的 session/cwd 子串 |
| `capture.retryPendingMs` | `120000` | 失败重试周期（0=关闭） |
| `recall.enabled` | `true` | 召回总开关 |
| `recall.autoInject` | `true` | 自动注入 |
| `recall.maxNodes` | `6` | 注入节点数上限 |
| `recall.maxChars` | `2400` | 注入块字符上限 |
| `recall.maxNodeChars` | `700` | 单节点截断 |
| `recall.minQueryChars` | `8` | 短于此不自动召回 |
| `recall.vectorTopK` | `40` | 向量候选数 |
| `recall.lexicalTopK` | `30` | 关键词候选数 |
| `recall.rrfK` | `60` | RRF 常数 |
| `recall.expansionDamping` | `0.55` | 扩散衰减 |
| `recall.maxExpansionNodes` | `24` | 扩散上限 |
| `recall.recencyHalfLifeDays` | `45` | 时效半衰期 |
| `recall.diversityCosine` | `0.88` | 多样性阈值 |
| `recall.timeoutMs` | `1500` | 自动召回超时 |
| `recall.scope` | `project+global` | 检索空间 |
| `recall.skipQueryPrefixes` | `["/","!","#"]` | 跳过命令式输入 |
| `recall.header` | 内置中文提示 | 覆盖召回块里的说明行 |
| `recall.vectorCacheMaxNodes` | `60000` | 进程内向量缓存上限（0=关闭） |
| `tools.enabled` | `true` | 工具总开关 |
| `tools.allowStore` | `true` | 允许 `mem_store` |
| `tools.allowDream` | `true` | 允许 `mem_dream` |
| `tools.allowRotate` | `true` | 允许 `mem_rotate` |
| `storage.tiered` | `true` | 启用 hot/warm/cold 分层；false=单文件 |
| `storage.hotDays` | `30` | 超过该天数的文档从 hot 迁出 |
| `storage.warmDays` | `180` | 超过该天数的文档进入 cold |
| `storage.warmFile` / `coldFile` | `<dataDir>/memory-warm.db` / `memory-cold.db` | 分层文件路径 |
| `storage.rotateOnOpen` | `true` | 启动后延迟执行一次轮转 |
| `storage.rotateIntervalMs` | `21600000` | 轮转定时器（6 小时；0=关闭） |
| `storage.rotateBatch` | `200` | 每个 hop 一次最多搬移的文档数 |
| `storage.dropColdVectors` | `false` | 冷层丢弃向量（体积↓、只剩关键词召回） |
| `storage.vacuumAfterRotate` | `false` | 轮转后压缩（慢，但回收磁盘） |
| `storage.tierWeights` | `{hot:1, warm:0.9, cold:0.78}` | 各层召回权重 |
| `mirror.enabled` | `true` | Markdown 镜像 |
| `mirror.dir` | `<dataDir>/memory` | 镜像目录 |

## 5. 后续阶段（与讨论中的架构对齐）

### Phase 2 — 巩固层（L2）

- 空闲时用本地小模型（Ollama / 27B / Bonsai）做：摘要、去重、抽象成规则、冲突检测（`supersedes`）；
- 引入 `mem_consolidate` 与“睡眠窗口”定时任务；
- 关键词检索升级为真分词或 BM25 打分（当前为 CJK bigram + FTS5）；
- `sqlite-vec` 作为可选加速（超过 5 万节点时启用）。

### Phase 3 — 参数化记忆（L3）

- 从 `recalls` + `nodes` 生成 `(query, decision)` 语料；
- 周期 LoRA 微调，适配器版本化、可回滚、带回归测试；
- 推理时“检索通道 + 适配器通道”并行，保留 `audit` 可解释性。

### Phase 4 — 多机与生态

- 记忆库加密同步（对象存储 / Syncthing）+ 版本号冲突解决；
- 抽出 MCP server（`src/engine` 已经与 DSH 解耦），供 Claude Code / 其它客户端复用；
- 可视化记忆图谱（Three.js：节点=记忆，边=软相似）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| embedding 服务不可用 | 捕获入库为 `pending`，定时重试；召回超时静默跳过 |
| 模型被召回内容带偏（prompt injection） | 帧转义 + “不可信资料”提示 + 引用要求 |
| 记忆膨胀 | `maxChars` 预算、`mem_dream` 去重、`archived` 字段预留 |
| 换 embedding 模型导致向量不可比 | `vectors.model` 记录模型；换模型需重建（文档已说明） |
| 隐私 | 全部本地；只有 embedding 文本出网；key 不入库 |
| 与官方未来记忆机制冲突 | 只依赖公开事件与工具注册；数据格式（SQLite + MD）可迁移 |
