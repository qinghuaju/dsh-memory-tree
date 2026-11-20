# Codex 接入：与 DSH 共用长期记忆

本版本保留 DSH 插件，并增加 Codex 的 MCP stdio 服务和生命周期 Hooks。
两端使用同一个 `dataDir`、embedding 配置和项目根路径时，可以互相召回记忆。
使用不同 `dataDir` 可以完全隔离数据。

## 安装

需要 Node ≥ 22.5，以及支持 `UserPromptSubmit` / `Stop` / `SessionStart` Hooks 的本地 Codex。
安装器使用当前 Node 可执行文件的绝对路径；移动仓库或升级后删除这个 Node 路径时，需要重新运行安装器。

```bash
npm ci

# 先查看将添加的配置；不会输出现有配置或密钥
node scripts/install-codex.mjs --dry-run

# 安装到当前 CODEX_HOME（默认 ~/.codex）
node scripts/install-codex.mjs
```

安装器备份并更新 `config.toml` 与 `hooks.json`，保留其他 MCP 和 Hooks。
重复执行不会重复注册。已有同名、非本安装器管理的 `memory_tree` MCP 配置时，会停止并要求手工合并。
它不会修改 embedding 密钥、自动开启被关闭的 Hooks 功能，或替用户信任 Hooks。
MCP 配置的 `env_vars` 只保存 embedding 密钥的环境变量名，运行时由 Codex 转交其值；不会把密钥值写入配置。

默认使用同步 Hooks，以兼容会跳过异步 Hooks 的旧版本（例如 Codex CLI 0.144.6）。
这会在回复结束时等待记忆入库。确认客户端支持后台 Hooks 后，可重新安装为 `node scripts/install-codex.mjs --async-hooks`；
修改 Hook 定义后需要重新审阅信任。`--sync-hooks` 可显式恢复默认方式。

重启 Codex 后，在 `/hooks` 中审阅并信任 Memory Tree 的三个 Hooks。
Codex 要求新建或修改后的非托管 Hooks 获得信任后才运行；未信任时 MCP 工具仍可单独使用。
桌面客户端的配置入口可能随版本变化，自动流程需要在所使用的客户端中验收。

仅对一个项目安装：

```bash
node scripts/install-codex.mjs --project /absolute/path/to/project
```

配置写入该项目的 `.codex/`；Codex 只加载受信任项目的配置。
全局安装和项目安装二选一，避免同一事件执行两份 Hooks。

## 记忆共享和配置

默认继续使用 `$DSH_HOME/memory-tree`（未设置 DSH_HOME 时为 `~/.dsh/memory-tree`），因此现有 DSH 数据无需迁移。
存储 schema v1 会在打开时原地升级为 v2，仅增加轮次 ID 查询索引，不改变正文和向量格式。
可通过 `MEMORY_TREE_DATA_DIR` 或 `--data-dir` 指定其他目录：

```bash
node scripts/install-codex.mjs --data-dir /absolute/path/to/shared-memory
```

DSH 插件也需要把 `dataDir` 设置为相同路径。共享目录中的 `config.json`、`credentials.json` 两端共用；
DSH patch 的显式配置仍优先，务必保持两端 embedding 模型、维度一致。运行时会拒绝已标记为其他模型/维度的数据库。
使用新模型时选新的数据目录，再导入原文。

MCP 和 Hooks 都读取现有 `capture`、`recall`、`storage`、`tools` 配置。
`enabled: false` 关闭全部功能；`capture.enabled: false` 关闭自动记录；
`recall.autoInject: false` 关闭自动召回，保留手动 `mem_recall`。
`tools.allowStore` / `allowDream` / `allowRotate` 控制对应工具是否暴露。

向量服务沿用项目原有配置。可用本地 Ollama；云端 provider 的文本会发往配置的 embedding endpoint。
`embedding.fake: true` 仅适合离线测试或演示，不代表真实语义检索质量。
安装器不会创建、申请或更改 API key。

## 每轮如何工作

1. `UserPromptSubmit` 接收 `prompt`、`cwd`、`session_id`、`turn_id`。
   脱敏后暂存问题，按当前项目检索历史，通过 `additionalContext` 返回有来源标记的 `<memory-recall>`。
   召回受 `recall.timeoutMs` 约束，失败或超时返回空 JSON，不阻止对话。
   安装器按此预算增加两秒进程启动余量（最少五秒）；修改预算后应重新运行安装器。
2. `Stop` 从 `last_assistant_message` 取最后一条助手回复，与该轮问题合并。
   默认等待入库完成；`--async-hooks` 可将它配置为后台 Hook。
3. `SessionStart` 重试之前未完成的入库任务，同样支持 `--async-hooks`。
   新会话第一次提问时，仍由 `UserPromptSubmit` 按问题召回；不预先注入无关历史。

这是**问题＋停止回调中的最后一条助手回复**的文本记忆。中间 commentary、工具输出、图片、
未产生 Stop 的中断回复不会自动收集。不会解析 Codex 内部 transcript 文件，也不会自动导入旧聊天。
同一轮重复 Stop 使用第一份已完成回复，避免后台回调重复入库。

`capture.includeAssistant: false` 时只保存问题。`capture.excludeSessions` 仍按会话 ID 或 cwd 子串排除；
匹配时既不捕获，也不自动召回。短于 `capture.minChars` 的问题不进入自动捕获队列。

## MCP 工具

| 工具 | 参数 |
|---|---|
| `mem_recall` | `query`, **`cwd`**, 可选 `scope`, `limit`, `path` |
| `mem_store` | `content`, **`cwd`**, 可选 `title`, `scope`, `importance` |
| `mem_stats` | 无 |
| `mem_dream` | **`cwd`**, 可选 `scope` |
| `mem_rotate` | 无 |

`cwd` 必须是当前任务项目的绝对路径。MCP 不把服务启动目录当作用户项目，避免全局服务混用项目记忆。
项目仍按 Git 根目录的路径识别；不同机器路径或不同 worktree 默认属于不同项目空间。
`mem_stats` 返回整个配置数据目录的统计；`mem_rotate` 维护整个数据目录。

如只需要工具，可以单独配置 MCP，省略 Hooks：

```toml
[mcp_servers.memory_tree]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/dsh-memory-tree/src/mcp/server.mjs", "--data-dir", "/absolute/path/to/shared-memory"]
# 改为 embedding 配置中使用的环境变量名
env_vars = ["OPENAI_API_KEY"]
startup_timeout_sec = 15
tool_timeout_sec = 600
```

## 新增本地文件与并发

| 文件 | 用途 |
|---|---|
| `codex-capture.db` | 已脱敏的问题暂存、完整轮次的持久重试队列及完成回执 |
| `memory.db.lock.db` | 用 SQLite 事务协调多个接入进程；不保存对话 |
| `plugin.log` | DSH / Codex 诊断日志 |

完成回执不保留正文；等待中的不完整轮次和回执七天后清理，完整但失败的入库任务保留以便重试。
后台 Hooks 可能在退出 Codex 时被终止，因此以持久队列和幂等写入恢复。

升级后的 DSH 和 Codex 接入进程共享操作锁，轮转、维护与入库不会相互交错。
进程崩溃后 SQLite 自动释放锁；自动召回遇到繁忙数据库时会在预算内跳过。
两端都必须使用升级后的代码，旧 DSH 插件副本不认识这个锁；DSH 的 `--copy-to` 安装需要重新执行。
直接使用底层 `createMemoryEngine` 的自定义程序仍须自行协调并发，或改用 `createEngineService`。
只支持同机共享；不要让两台机器同时写网络盘上的 SQLite。

## 验收与卸载

```bash
npm run selftest
npm run test:codex
npm run test:compat
node scripts/check-secrets.mjs
```

测试使用 fake embedder 和临时目录，不发送真实聊天、不读取真实密钥、不改个人 Codex 配置。

安装后，先调用 `mem_stats`，再在项目 A 的聊天里保存一条决定。
新建同项目聊天，询问这条决定；再去项目 B 确认不会召回项目 A 的内容。
如同时使用 DSH，在 DSH 中确认同一项目的 Codex 笔记可检索。

```bash
node scripts/install-codex.mjs --uninstall
# 项目级安装用相同作用域卸载
node scripts/install-codex.mjs --project /absolute/path/to/project --uninstall
```

卸载只移除本安装器管理的条目，记忆数据库、备份和其他配置保留。

官方接入协议：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)。
