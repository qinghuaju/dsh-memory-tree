# 部署到另一台机器

[English](DEPLOY.md) | 中文

插件是纯 ESM + Node 内置模块：没有原生编译、没有外部数据库、没有常驻服务。
所以“部署”本质上就是**拷文件 + 让 DSH profile 指向它**。

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| DSH | 0.1.x 以上 | 自带 Node 24，`node:sqlite` 可用 |
| Node（跑 CLI 时） | ≥ 22.5 | 只在 DSH 外跑 `scripts/*.mjs` 时需要 |
| 磁盘 | 约 6 KB / 记忆节点 | 1k 节点 ≈ 9 MB，30k ≈ 170 MB（见基准测试） |
| Embedding API | 任意 OpenAI 兼容 `/v1/embeddings` | 默认 Pollinations，也可 DashScope / OpenAI / 本地 Ollama |
| 网络 | 能访问 embedding endpoint | 用 Ollama 可全本地；`embedding.fake` 可完全离线 |

## 1. 选一种部署方式

### A. 打包拷贝（换机器推荐）

装进 profile 的 `node_modules` 之后，插件会从 `~/.dsh/profiles/node_modules`
解析 DSH 自己的 `@deepseek-ai/*` 包，因此它**没有自己的依赖树**要装。

```bash
# 1) 把仓库拷到目标机器（git clone / 压缩包 / scp）
# 2) 在拷贝后的目录里：
node scripts/install.mjs --dry-run          # 先看会改什么
node scripts/install.mjs --copy-to          # 装到 <profile>/node_modules/dsh-memory-tree
```

> **装到哪个 profile？** 桌面版加载 `~/.dsh/profiles/desktop`；`dsh web` 命令行服务
> 加载 `~/.dsh/profiles/web`。装错 profile 的表现是**静默不生效**（没有工具、不记录）。
> 不确定就显式指定：
>
> ```bash
> node scripts/install.mjs --profile "$DSH_HOME/profiles/desktop" --copy-to
> ```
>
> 只装一个 profile：两个 profile 同时运行会同时写 `~/.dsh/memory-tree/memory.db`，
> 而 SQLite 只允许一个写入者。

`--copy-to` 会复制 `src/`、`docs/`、`package.json`、README、LICENSE、CHANGELOG，
并往 `cordis.patch.yml` 追加一条：

```yaml
- insert:
    - id: dsh-memory-tree
      name: 'dsh-memory-tree'
      config: { enabled: true, /* ... */ }
```

装完源码目录就可以移动或删除。想装到别处：

```bash
node scripts/install.mjs --copy-to "D:\dsh-plugins\dsh-memory-tree"
# 放在 node_modules 之外时，安装器会写一个绝对 file URL 的转发文件
```

### B. 开发目录直连

```bash
node scripts/install.mjs
```

在 profile 里写 `dsh-memory-tree.plugin.mjs` 转发到本仓库。适合改代码时用，
但目录不能移走。

### C. npm / tarball

```bash
# 打包机
npm pack                                  # dsh-memory-tree-0.1.0.tgz

# 目标机
cd ~/.dsh/profiles/web
pnpm add "file:/path/to/dsh-memory-tree-0.1.0.tgz"
# 然后在 cordis.patch.yml 里按包名添加：
#   - insert:
#       - id: dsh-memory-tree
#         name: 'dsh-memory-tree'
```

发布到 npm 之后，`pnpm add dsh-memory-tree` 即可。

## 2. 配置 embedding key（三选一）

| 方式 | 做法 | 适用 |
|---|---|---|
| 凭据文件 | `$DSH_HOME/memory-tree/credentials.json` 写 `{"apiKey":"sk-..."}` | 日常桌面使用 |
| 环境变量 | 启动 DSH 前设 `MEMORY_TREE_API_KEY` | CI、共享机器、密钥管理器 |
| DSH credentials | `embedding.apiKeyEnv: MY_KEY_NAME` + `~/.dsh/.credentials.yaml` | 所有密钥统一放 DSH |

**不要把 key 写进 `cordis.patch.yml` 或仓库**——`node scripts/check-secrets.mjs` 会拦截。

完全本地（无 key、不出网）：

```yaml
config:
  embedding:
    preset: ollama          # http://127.0.0.1:11434/v1, bge-m3
    sendDimensions: false
```

## 3. 重启并验证

1. 重启 DeepSeek Harness；
2. 让 Agent 调 `mem_stats`，应返回数据库路径、模型名、各层计数；
3. 聊两轮，确认热层文件出现：

```bash
ls -l "$DSH_HOME/memory-tree"
# memory.db  memory.db-wal  memory/（Markdown 镜像）  credentials.json
```

4. 新开会话问之前聊过的内容：模型应收到一个 `<memory-recall>` 块
   （会话记录里显示为折叠的上下文消息）。

不启动 DSH 也能直接查库：

```bash
node scripts/inspect.mjs          # 各层文件、条数、空间、最新文档、镜像文件数
node scripts/inspect.mjs --json   # 给脚本用
```

## 4. 迁移记忆库

整套“大脑”就是一个目录：

```
$DSH_HOME/memory-tree/
├── memory.db          # 热层
├── memory-warm.db     # 温层（第一次轮转后出现）
├── memory-cold.db     # 冷层
├── memory/            # Markdown 镜像（可读、可 git）
└── credentials.json   # 可选；拷给别人时请排除
```

把这整个目录拷到新机器，**在启动 DSH 之前**放好。只要 embedding 模型与维度不变，
向量仍然可比，无需重建索引。

注意事项：

- **绝不要让两台机器同时写同一个 SQLite 文件**（网络盘、Dropbox、OneDrive）。
  SQLite 单写入者，会损坏或被锁死；
- 单向 rsync（只推不拉）或只对 Markdown 镜像用 git 是安全的；
- 换 `embedding.model` / `embedding.dimensions` 后，请删除旧的分层文件
  （或换 `dataDir`）：不同模型的向量不可比较。

## 5. 升级 / 卸载

```bash
# 升级：替换目录后重跑安装器（幂等）
node scripts/install.mjs --copy-to

# 卸载（保留记忆数据）
node scripts/install.mjs --uninstall
```

> **升级后请重启 DSH。** 宿主只能热替换插件入口文件（`plugin.mjs`），它 import 的模块
> （`host-client.mjs`、`engine-host.mjs`、`engine/*`）在第一次加载后会被 ESM 缓存，
> 热重载不会更新它们。重启后 `plugin.log` 会出现新的 `engine child spawned (... runtime=...)`。

`--uninstall` 会删除包拷贝、让转发文件失效、删掉 patch 条目（并留备份），
`$DSH_HOME/memory-tree` 里的数据不动。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具里没有 `mem_stats` | 插件没加载 | 检查 patch 条目的 id/name，重启 DSH，看加载错误 |
| 日志 `no embedding API key` | 找不到 key | 放 `credentials.json` 或设 `MEMORY_TREE_API_KEY` |
| `dsh-memory-tree needs Node 22.5+` | DSH 用了旧 Node | 用 DSH 自带运行时启动 |
| 刚装完召回为空 | 还没捕获任何内容 | 聊几轮，或 `mem_store` 一条，再看 `mem_stats` |
| 记忆一直搜不到 | embedding 失败 | `mem_stats` 的 `pending` 不为 0；插件每 2 分钟重试，或重启 |
| 旧记忆搜不到 | 已轮转到温/冷层，查询太短 | 调大 `recall.maxNodes`，或 `storage.tiered: false` |
| 冷层文件涨得快 | 冷层保留了向量 | `storage.dropColdVectors: true`（冷层只做关键词召回） |
| `SQLITE_BUSY` | 两个写入者（另一个 agent + CLI） | 避免并发写；`busy_timeout` 已设 5 秒 |
| 对话正常但记忆不更新 | 引擎子进程崩了、正在重启 | 看 `$DSH_HOME/memory-tree/plugin.log`。宿主不受影响：子进程按 1s/2s/4s 退避重启，10 分钟内 3 次后停住；重启 DSH 或再调用任一 `mem_*` 工具会重新拉起 |
