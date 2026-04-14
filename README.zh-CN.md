# Simple Agent

一个基于 TypeScript 的 Claude Code Agent 学习项目，演示了 19 个渐进式的 Agent 模式。每个文件都是使用 OpenAI 兼容 API 客户端的独立可运行示例。

## 概述

本项目包含 19 个示例文件（s01-s19），每个文件教授一种特定的 Agent 模式：

| 文件 | 主题 | 描述 |
|------|-------|-------------|
| s01 | Agent Loop | 基础 Agent 循环：消息 → 回复 → 工具执行 |
| s02 | Tool Use | 带文件操作的工具分发 |
| s03 | Todo Write | 带待办跟踪的会话规划 |
| s04 | Subagent | 通过子代理实现上下文隔离 |
| s05 | Skill Loading | 从 SKILL.md 文件按需加载技能 |
| s06 | Context Compact | 上下文压缩和历史摘要 |
| s07 | Permission System | 基于模式的权限门控（default/plan/auto） |
| s08 | Hook System | Pre/Post 工具使用钩子以实现可扩展性 |
| s09 | Memory System | 跨会话的持久化记忆 |
| s10 | System Prompt | 基于流水线的系统提示构建 |
| s11 | Error Recovery | API 错误处理和重试逻辑 |
| s12 | Task System | 带依赖关系的持久化任务图 |
| s13 | Background Tasks | 异步命令执行 |
| s14 | Cron Scheduler | 基于时间的定时任务 |
| s15 | Agent Teams | 通过消息总线实现多 Agent 协作 |
| s16 | Team Protocols | 关闭和计划批准协议 |
| s17 | Autonomous Agents | 自主任务认领和空闲轮询 |
| s18 | Worktree Isolation | Git worktree 集成实现并行工作 |
| s19 | MCP Plugin | Model Context Protocol 集成 |

## 前提条件

- Node.js 18+
- OpenAI 兼容 API 密钥（阿里云百炼或类似服务）

## 安装

```bash
npm install
```

## 配置

在 `.env` 文件中设置环境变量：

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_ID=qwen-max
```

## 常用命令

| 命令 | 描述 |
|---------|-------------|
| `npx tsx sXX_*.ts` | 运行任何示例 |
| `q` 或 `exit` | 退出交互模式 |
| `/help` | 显示可用命令（如支持） |
| `/compact` | 手动触发上下文压缩（s06） |
| `/tasks` | 显示任务列表（s12, s13） |
| `/team` | 显示团队成员（s15, s16） |
| `/inbox` | 检查消息（s15, s16, s17） |
| `/cron` | 列出定时任务（s14） |
| `/prompt` | 显示系统提示（s10） |
| `/tools` | 列出可用工具（s19） |
| `/mcp` | 显示 MCP 服务器状态（s19） |

## 详细示例

### s01_agent_loop.ts - 基础 Agent 循环

**目的：** 演示最小 Agent 循环：用户消息 → 模型回复 → 工具执行 → 工具结果 → 继续。

**运行方式：**
```bash
npx tsx s01_agent_loop.ts
```

**推荐提示词：**
```
列出当前目录下的所有 .ts 文件
```
```
统计 package.json 的行数
```
```
显示最近 3 次 git 提交
```

**观察要点：** Agent 执行 bash 命令并显示输出。每轮执行前会以黄色显示命令。

---

### s02_tool_use.ts - 多工具支持

**目的：** 在 bash 基础上添加文件操作（read_file, write_file, edit_file）。

**运行方式：**
```bash
npx tsx s02_tool_use.ts
```

**推荐提示词：**
```
读取 package.json 并显示依赖项
```
```
创建一个名为 test.txt 的文件，内容为 hello world
```
```
编辑 test.txt 添加第二行内容
```

**观察要点：** 工具通过处理器映射分发。Agent 为每个操作选择合适的工具。

---

### s03_todo_write.ts - 会话规划

**目的：** 为多步骤任务引入待办跟踪。每 3 轮提醒用户更新待办事项。

**运行方式：**
```bash
npx tsx s03_todo_write.ts
```

**推荐提示词：**
```
帮我重构代码库。首先列出所有 TypeScript 文件，然后分析每个文件的 TODO 注释。
```
```
我想添加一个新功能：1) 创建配置文件，2) 更新 package.json，3) 编写测试
```

**特殊命令：**
```
/todos - 显示当前待办列表
```

**观察要点：** Agent 维护待办列表并提醒你保持更新。

---

### s04_subagent.ts - 子代理生成

**目的：** 演示生成具有独立上下文的子代理来处理隔离任务。

**运行方式：**
```bash
npx tsx s04_subagent.ts
```

**推荐提示词：**
```
将统计所有 .ts 文件的任务委托给子代理
```
```
创建一个子代理来分析项目结构
```

**观察要点：** 子代理独立运行并向父代理返回摘要。

---

### s05_skill_loading.ts - 技能加载

**目的：** 从 skills/ 目录中的 SKILL.md 文件加载技能。

**运行方式：**
```bash
npx tsx s05_skill_loading.ts
```

**推荐提示词：**
```
有哪些可用技能？
```
```
加载代码审查技能并使用它
```

**观察要点：** 技能列在系统提示中，完整技能内容按需加载。

---

### s06_context_compact.ts - 上下文压缩

**目的：** 当上下文超过令牌阈值时自动压缩。

**运行方式：**
```bash
npx tsx s06_context_compact.ts
```

**推荐提示词：**
```
让我们进行关于项目结构的长对话。首先列出所有文件，然后逐个分析...
```
```
/compact - 手动触发压缩
```

**观察要点：** 当上下文变大时，旧消息会自动被摘要。

---

### s07_permission_system.ts - 权限门控

**目的：** 三种权限模式：default（询问写入）、plan（询问所有工具）、auto（允许非破坏性操作）。

**运行方式：**
```bash
npx tsx s07_permission_system.ts
```

**推荐提示词：**
```
删除 test.txt 文件
```
```
读取 package.json
```

**权限模式：**
- `default`: 询问状态变更操作
- `plan`: 询问所有操作
- `auto`: 允许读取操作，询问写入

**观察要点：** 权限提示根据当前模式出现。

---

### s08_hook_system.ts - 钩子系统

**目的：** 为 PreToolUse、PostToolUse 和 SessionStart 事件提供可扩展的钩子。

**运行方式：**
```bash
npx tsx s08_hook_system.ts
```

**推荐提示词：**
```
运行任何 bash 命令并观察钩子输出
```

**配置：** 创建 `.hooks.json` 定义自定义钩子。

**观察要点：** 钩子在工具执行前后触发。

---

### s09_memory_system.ts - 记忆系统

**目的：** 四种类型的持久化记忆：user、feedback、project、reference。

**运行方式：**
```bash
npx tsx s09_memory_system.ts
```

**推荐提示词：**
```
记住我更喜欢 TypeScript 而不是 JavaScript
```
```
你知道我的哪些偏好？
```

**记忆文件：** 存储在 `.claude/projects/<hash>/memory/` 目录，使用 frontmatter 格式。

**观察要点：** 记忆跨会话持久化并自动加载。

---

### s10_system_prompt.ts - 系统提示构建器

**目的：** 从多个部分构建系统提示：核心、工具、技能、记忆、CLAUDE.md、动态上下文。

**运行方式：**
```bash
npx tsx s10_system_prompt.ts
```

**推荐提示词：**
```
/prompt - 显示完整系统提示
```
```
/sections - 仅显示章节标题
```
```
你有哪些可用工具？
```

**观察要点：** 系统提示由章节流水线构建。

---

### s11_error_recovery.ts - 错误恢复

**目的：** 使用指数退避重试逻辑处理 API 错误。

**运行方式：**
```bash
npx tsx s11_error_recovery.ts
```

**推荐提示词：**
```
通过发送请求测试错误处理
```

**观察要点：** Agent 对瞬时错误使用指数退避重试。

---

### s12_task_system.ts - 任务管理

**目的：** 基于文件的任务系统，支持依赖关系（blockedBy/blocks）。

**运行方式：**
```bash
npx tsx s12_task_system.ts
```

**推荐提示词：**
```
创建一个重构代码库的任务
```
```
列出所有任务及其依赖关系
```

**特殊命令：**
```
/tasks - 显示任务列表
/task create <description> - 创建新任务
/task complete <id> - 标记任务完成
```

**观察要点：** 任务持久化到 `.tasks/` 目录。

---

### s13_background_tasks.ts - 后台执行

**目的：** 异步运行长时间运行的命令而不阻塞。

**运行方式：**
```bash
npx tsx s13_background_tasks.ts
```

**推荐提示词：**
```
在后台运行 sleep 命令 5 秒
```
```
启动一个长时间构建进程并在完成时通知我
```

**特殊命令：**
```
/tasks - 检查后台任务状态
```

**观察要点：** 后台任务立即返回并在完成时通知。

---

### s14_cron_scheduler.ts - Cron 调度

**目的：** 使用 5 字段 cron 表达式在特定时间安排提示运行。

**运行方式：**
```bash
npx tsx s14_cron_scheduler.ts
```

**推荐提示词：**
```
安排每小时检查一次测试的提醒
```
```
今天下午 3 点提醒我审查 PR
```

**特殊命令：**
```
/cron - 列出已安排的作业
```

**Cron 格式：** `M H DoM Mon DoW`（例如 `0 9 * * *` = 每天上午 9 点）

**观察要点：** 持久化作业存储到 `.claude/scheduled_tasks.json`。

---

### s15_agent_teams.ts - Agent 团队

**目的：** 通过消息总线和收件箱系统实现多 Agent 协作。

**运行方式：**
```bash
npx tsx s15_agent_teams.ts
```

**推荐提示词：**
```
生成一个队友来帮助代码审查
```
```
发送消息给审查代理
```

**特殊命令：**
```
/team - 显示团队成员
/inbox - 检查消息
```

**观察要点：** Agent 通过共享消息总线通信。

---

### s16_team_protocols.ts - 团队协议

**目的：** 定义团队通信协议（shutdown_request、plan_approval）。

**运行方式：**
```bash
npx tsx s16_team_protocols.ts
```

**推荐提示词：**
```
请求队友优雅地关闭
```
```
提交计划以待批准
```

**协议类型：**
- `shutdown_request/shutdown_response` - 优雅关闭
- `plan_approval` - 带 request_id 关联的计划审查

**观察要点：** 结构化协议消息确保可靠通信。

---

### s17_autonomous_agents.ts - 自主 Agent

**目的：** 自主认领任务并在空闲时轮询的 Agent。

**运行方式：**
```bash
npx tsx s17_autonomous_agents.ts
```

**推荐提示词：**
```
启动一个自主 Agent 来监控任务队列
```

**特殊命令：**
```
/inbox - 检查新任务
/claim - 认领待处理任务
```

**观察要点：** Agent 自动认领任务并在上下文压缩后重新注入身份。

---

### s18_worktree_task_isolation.ts - Worktree 隔离

**目的：** Git worktree 集成实现并行任务隔离。

**运行方式：**
```bash
npx tsx s18_worktree_task_isolation.ts
```

**推荐提示词：**
```
为新功能分支创建 worktree
```
```
在隔离的 worktree 中运行任务
```

**观察要点：** 每个任务在具有隔离分支的独立 git worktree 中运行。

---

### s19_mcp_plugin.ts - MCP 集成

**目的：** Model Context Protocol 集成，用于外部工具服务器。

**运行方式：**
```bash
npx tsx s19_mcp_plugin.ts
```

**推荐提示词：**
```
/tools - 列出所有可用工具，包括 MCP
```
```
/mcp - 显示 MCP 服务器状态
```

**特殊命令：**
```
/tools - 显示工具目录
/mcp - 显示已连接的 MCP 服务器
```

**MCP 工具命名：** `mcp__{server}__{tool}`（例如 `mcp__filesystem__read_file`）

**观察要点：** MCP 工具与本地工具一起被发现和调用。

---

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent 循环                               │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │  用户    │───>│  模型    │───>│  工具    │              │
│  │  输入    │    │  回复    │    │  执行    │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│       ^                                |                    │
│       |________________________________|                    │
│              工具结果                                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    工具注册表                                │
│  Native: bash, read_file, write_file, edit_file             │
│  MCP: mcp__{server}__{tool}                                 │
│  Skills: 从 SKILL.md 加载                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   支持系统                                   │
│  权限门控   │  记忆     │  钩子                            │
│  任务管理   │  Cron     │  消息总线                         │
│  Worktree 管理 │  子代理  │  上下文压缩器                     │
└─────────────────────────────────────────────────────────────┘
```

## 学习路径

示例按以下顺序构建：

1. **基础（s01-s02）：** Agent 循环和工具分发
2. **规划（s03, s12-s13）：** 待办、任务、后台执行
3. **上下文（s04-s06, s10）：** 子代理、技能、压缩、系统提示
4. **安全（s07-s08）：** 权限和钩子
5. **持久化（s09, s14）：** 记忆和 Cron
6. **恢复（s11）：** 错误处理
7. **协作（s15-s17）：** 团队、协议、自主 Agent
8. **隔离（s18）：** 并行工作的 Worktree
9. **集成（s19）：** MCP 插件系统

## 参考实现

`s_full.ts` 将所有模式组合成一个参考实现。构建生产 Agent 时可作为指南。

## 许可证

MIT
