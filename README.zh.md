# dsh-memory-tree

**给 DeepSeek Harness（DSH）的跨会话长期记忆：AST 结构化索引 + 分层 SQLite + 向量召回。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-40%20offline%20checks-success.svg)](scripts/selftest.mjs)
[![dsh](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

[English](README.md) | 中文

---

Agent 会忘事。任务结束，上下文清空，压缩摘要随会话消失；同一个项目里新开会话，
一切从零讲起。一个月前存下的笔记，也不会在新想法出现时自己浮上来。

这个插件把记忆从"上下文里的消耗品"变成**磁盘上的资产**：

- **捕获**：每条 user/assistant 消息在后台落盘，按"一轮对话"合并；
- **索引**：切成可寻址的 AST 节点（标题/小节/段落/要点），带 embedding 和软相似边；
- **召回**：每轮开始前检索，注入**一段有界**的 `<memory-recall>`，不是塞全部历史；
- **分层**：按年龄把数据分到 hot / warm / cold 三个 SQLite 文件，活跃文件不会越用越大；
- **工具**：`mem_recall` / `mem_store` / `mem_stats` / `mem_dream` / `mem_rotate`。

没有外部服务、没有原生编译；整个"大脑"就是一个目录，可复制、可检查、可备份、可删除。

## 快速开始

```bash
# 1) 放 key（不要放进仓库）
echo '{"apiKey":"sk-..."}' > "$DSH_HOME/memory-tree/credentials.json"

# 2) 装进应用实际加载的 profile，然后重启 DSH
#    桌面版 → ~/.dsh/profiles/desktop    dsh web → ~/.dsh/profiles/web
node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to

# 3) 在 DSH 里让 Agent 调一次 mem_stats 验证
```

聊两轮，然后**新开会话**问第一轮里的内容——召回块会出现。

换机器、npm/tarball、纯离线部署见 **[docs/DEPLOY.zh.md](docs/DEPLOY.zh.md)**。

## 用 Git 安装

```bash
git clone https://github.com/qinghuaju/dsh-memory-tree.git
cd dsh-memory-tree

# 选应用实际加载的 profile（桌面版 / dsh web 不同）
node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to

# 重启 DSH，然后让 Agent 调一次 mem_stats
```

安装器幂等、会备份 `cordis.patch.yml`，且不会碰你的密钥；不带 `--profile` 时它会自动选择并提示。

## 从插件市场安装

DSH 0.2.1-rc.3 的市场**默认关闭、且没有预置索引**。要发布或使用，先生成 `market/index.json`，
再到 **设置 → 插件 → Discover** 添加索引 URL：

```bash
node scripts/market-index.mjs --owner qinghuaju --commit <40位sha> --npm
node scripts/check-market.mjs
```

完整 schema、托管方式与“官方市场”现状见 **[docs/MARKET.zh.md](docs/MARKET.zh.md)**。

## 兼容性

在 DSH **0.2.1-rc.3**（自带 Node 24）上测试，Windows 与 Linux CI；CLI 需要 Node ≥ 22.5。
插件没有原生编译、没有自己的运行时依赖树——`@deepseek-ai/*` 从 profile 解析。


## 为什么不直接用向量库

| 需求 | 扁平 chunk RAG | 本项目 |
|---|---|---|
| 找到相似文本 | ✅ | ✅ embedding |
| 定位"上次那个光遗传学方案" | ❌ 匿名 chunk | ✅ 唯一 AST 路径 |
| 命中段落时带出所属小节 | ❌ | ✅ 一跳激活扩散 |
| 解释"为什么召回这条" | ❌ 只有一个余弦值 | ✅ 六个具名分项 + 审计表 |
| 控制活跃库体积 | ❌ 无限增长 | ✅ hot/warm/cold 轮转 |
| 离线 / 不绑定厂商 | 看情况 | ✅ Ollama，或确定性 fake embedder |
| 人类可读、可迁移 | 看情况 | ✅ SQLite 旁边有 Markdown 镜像 |

原理、取舍、以及"哪些坑是实测踩出来的"：**[docs/PRINCIPLES.zh.md](docs/PRINCIPLES.zh.md)**。

## 工作原理

```
session/event ──▶ 捕获缓冲（按会话，按轮次合并）
                    │
                    ▼
              AST 解析 ──▶ 节点（path / kind / title / content）
                    │
                    ▼
              embedding ──▶ float32 向量 + 相似边（cos ≥ 0.72）
                    │
                    ▼
   memory.db（热，<30天） ──轮转──▶ memory-warm.db（30–180天） ──▶ memory-cold.db（>180天）
                    │
   agent/pre-step ──▶ 查询 ──▶ 向量 ∪ FTS 候选 ──▶ 混合打分 ──▶ <memory-recall>
```

打分公式（每一项为什么存在见 [PRINCIPLES](docs/PRINCIPLES.zh.md#4-检索打分)）：

```
base = (0.55·余弦 + 0.20·关键词 + 0.25·两路一致性) × 层级权重
     + 一跳：父节点 ×0.55，相似邻居 ×0.55·相似度
     + 先验：0.06·重要度 + 0.05·时效(45天半衰) + 0.03·使用频次
```

## 实测数据

`node scripts/bench.mjs --sizes 1000,10000,30000`（本机 Windows / Node 24 / fake embedder，
测的是存储与检索路径，不含网络）：

| 节点数 | 库大小 | 召回 p50 | 召回 p95 | 轮转 | 轮转后热层文件 |
|---|---|---|---|---|---|
| 1,001 | 5.4 MB | 11.6 ms | 15.2 ms | 137 文档 / 0.5 s | **0.36 MB** |
| 10,003 | 54.1 MB | 55.9 ms | 68.4 ms | 1,370 文档 / 6.0 s | **2.48 MB** |
| 30,002 | 162.6 MB | 191.2 ms | 258.3 ms | 4,109 文档 / 25.6 s | **7.23 MB** |

- 约 5.4 KB / 节点（其中 1024 维向量约占 4 KB）；
- 热层只保留保留期内的内容——这就是分层的意义；
- 轮转是"移动整文档"，`compact()` 回收已释放页；
- 真实使用还要加一次 embedding 往返；自动召回受 `recall.timeoutMs`（1.5 秒）约束，
  超时就静默跳过，不拖慢这一轮。

## 分层存储

| 层 | 文件 | 默认年龄 | 向量 | 检索权重 |
|---|---|---|---|---|
| 热 | `memory.db` | < 30 天 | 保留 | 1.00 |
| 温 | `memory-warm.db` | 30–180 天 | 保留 | 0.90 |
| 冷 | `memory-cold.db` | > 180 天 | 默认保留；`dropColdVectors: true` 可丢 | 0.78 |

轮转由定时器（6 小时）、启动后的延迟任务、`mem_rotate` 工具三处触发；搬的是整份文档
（nodes + vectors + 路径 + 时间戳），不删除内容。丢向量的冷层仍可关键词命中，体积小一个量级。

想要旧的单文件行为：`storage.tiered: false`。

## 配置

```yaml
- insert:
    - id: dsh-memory-tree
      name: 'dsh-memory-tree'
      config:
        embedding:
          preset: pollinations     # pollinations | dashscope | openai | ollama | custom
          dimensions: 1024
        capture:
          enabled: true
        recall:
          autoInject: true
          maxNodes: 6
          timeoutMs: 1500
        storage:
          tiered: true
          hotDays: 30
          warmDays: 180
```

完整配置项与默认值见 [docs/PHASE1.md](docs/PHASE1.md#4-配置参考完整)。

同一份配置也可以写进 `$DSH_HOME/memory-tree/config.json`（CLI 与插件共用；patch 里的配置优先级更高）。
环境变量：`MEMORY_TREE_API_KEY`、`MEMORY_TREE_DATA_DIR`、`MEMORY_TREE_EMBED_PRESET`。

## 工具

| 工具 | 作用 |
|---|---|
| `mem_recall` | 检索项目 + 全局记忆，可按 AST 路径过滤 |
| `mem_store` | 写入 durable 笔记（跨项目偏好用 `scope: global`） |
| `mem_stats` | 各层文档/节点/向量、体积、待嵌入数 |
| `mem_dream` | 去重节点、重建软边 |
| `mem_rotate` | 立即执行一次分层轮转 |

参数表、返回结构、引擎 API 与 CLI 说明：**[docs/TOOLS.zh.md](docs/TOOLS.zh.md)**。

## 默认就是安全的

- **进程隔离**：记忆引擎（SQLite、embedding、轮转）跑在独立子进程里；它崩了不会带走对话，
  客户端会自动重启，并把现场写进 `$DSH_HOME/memory-tree/plugin.log`；
- 只存本地；唯一出网的是送去算 embedding 的文本；
- 召回内容按**不可信资料**框定，帧标记会被转义，防止内容越狱出块；
- 注入消息带来源标记，捕获时跳过——记忆不会记自己；
- key 只从 env / `credentials.json` 读，不进日志、不进 prompt、不进 patch
  （[`scripts/check-secrets.mjs`](scripts/check-secrets.mjs) 在 CI 里强制检查）；
- 不会发帖、评论、发邮件，也不会请求任意 URL（见 [SECURITY.md](SECURITY.md)）。

## CLI

同一个库可以在 DSH 外直接用：

```bash
node scripts/demo.mjs index ./notes --scope project
node scripts/demo.mjs recall "光遗传学 艺术装置" --limit 5
node scripts/demo.mjs stats
node scripts/demo.mjs rotate
```

## 常见问题

**记忆多了会变慢吗？**
召回是对活跃空间的扫描：本机 1k 节点 12ms、10k 56ms、30k 191ms。分层让热层文件保持很小；
超过约 5 万节点时，可以在 `store.listVectors` 这个接口后面接 `sqlite-vec`。

**可以完全不用云端 key 吗？**
可以。`embedding.preset: ollama` + `bge-m3` 全本地；测试/演示用 `embedding.fake: true`。

**换 embedding 模型怎么办？**
不同模型的向量不可比。换 `dataDir`（或删掉分层文件）让它重建索引；原文在 Markdown 镜像里。

**两台机器能共用吗？**
可以把 `$DSH_HOME/memory-tree/` 拷过去，但**绝不能让两台机同时写同一个 SQLite 文件**。
只做单向同步，或只对 Markdown 镜像用 git。多写入者的 CRDT 同步在路线图里。

**它替代 AGENTS.md / CLAUDE.md 吗？**
不替代。那是你维护的"指令"，它是 Agent 自己积累的"历史"，两者互补。

**对话内容会被上传吗？**
只有被捕获的文本片段会发给你配置的 embedding endpoint。没有 telemetry，也不会上传数据库。

## 路线图

- [x] Phase 1 — AST + embedding + SQLite、捕获、自动召回、工具、分层文件
- [ ] Phase 2 — 离线巩固：摘要、合并、冲突检测（`supersedes`）、BM25
- [ ] Phase 3 — 参数化记忆：从召回/决策日志训练可回滚的 LoRA 适配器
- [ ] Phase 4 — 给非 DSH 客户端用的 MCP server、CRDT 多机同步、3D 记忆图谱

细节见 [docs/PHASE1.md](docs/PHASE1.md)。

## 参与贡献

欢迎 issue 与 PR，先读 [CONTRIBUTING.md](CONTRIBUTING.md)：引擎必须零依赖、行为改动必须带离线测试、
`check-secrets` 必须保持干净。如果它帮你省下过一次会话，点个 star 能让更多 DSH 用户找到它。

## License

MIT
