# Simple Agent

A TypeScript-based learning project for Claude Code Agents, demonstrating 19 progressive agent patterns. Each file is a self-contained, runnable example using the OpenAI-compatible API client.

## Overview

This project contains 19 example files (s01-s19), each teaching a specific agent pattern:

| File | Topic | Description |
|------|-------|-------------|
| s01 | Agent Loop | Basic agent loop: message → reply → tool execution |
| s02 | Tool Use | Tool dispatch with file operations |
| s03 | Todo Write | Session planning with todo tracking |
| s04 | Subagent | Context isolation via subagents |
| s05 | Skill Loading | On-demand skill loading from SKILL.md files |
| s06 | Context Compact | Context compression and history summarization |
| s07 | Permission System | Mode-based permission gates (default/plan/auto) |
| s08 | Hook System | Pre/Post tool use hooks for extensibility |
| s09 | Memory System | Persistent memory across sessions |
| s10 | System Prompt | Pipeline-based system prompt construction |
| s11 | Error Recovery | API error handling and retry logic |
| s12 | Task System | Durable task graph with dependencies |
| s13 | Background Tasks | Async command execution |
| s14 | Cron Scheduler | Time-based scheduled tasks |
| s15 | Agent Teams | Multi-agent collaboration via message bus |
| s16 | Team Protocols | Shutdown and plan approval protocols |
| s17 | Autonomous Agents | Self-directed task claiming and idle polling |
| s18 | Worktree Isolation | Git worktree integration for parallel work |
| s19 | MCP Plugin | Model Context Protocol integration |

## Prerequisites

- Node.js 18+
- API Key for OpenAI-compatible endpoint (Alibaba DashScope or similar)

## Installation

```bash
npm install
```

## Configuration

Set your environment variables in `.env`:

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_ID=qwen-max
```

## Common Commands

| Command | Description |
|---------|-------------|
| `npx tsx sXX_*.ts` | Run any example |
| `q` or `exit` | Exit interactive mode |
| `/help` | Show available commands (where supported) |
| `/compact` | Manually trigger context compression (s06) |
| `/tasks` | Show task list (s12, s13) |
| `/team` | Show team members (s15, s16) |
| `/inbox` | Check messages (s15, s16, s17) |
| `/cron` | List scheduled jobs (s14) |
| `/prompt` | Show system prompt (s10) |
| `/tools` | List available tools (s19) |
| `/mcp` | Show MCP server status (s19) |

## Detailed Examples

### s01_agent_loop.ts - Basic Agent Loop

**Purpose:** Demonstrates the minimal agent loop: user message → model reply → tool execution → tool result → continue.

**How to run:**
```bash
npx tsx s01_agent_loop.ts
```

**Recommended prompts:**
```
List all .ts files in the current directory
```
```
Count the number of lines in package.json
```
```
Show me the git log for the last 3 commits
```

**What to observe:** The agent executes bash commands and displays output. Each turn shows the command in yellow before execution.

---

### s02_tool_use.ts - Multi-Tool Support

**Purpose:** Adds file operations (read_file, write_file, edit_file) alongside bash.

**How to run:**
```bash
npx tsx s02_tool_use.ts
```

**Recommended prompts:**
```
Read the contents of package.json and show me the dependencies
```
```
Create a file called test.txt with hello world
```
```
Edit test.txt to add a second line
```

**What to observe:** Tools are dispatched through a handler map. The agent chooses the appropriate tool for each operation.

---

### s03_todo_write.ts - Session Planning

**Purpose:** Introduces todo tracking for multi-step tasks. Reminds user to update todos every 3 rounds.

**How to run:**
```bash
npx tsx s03_todo_write.ts
```

**Recommended prompts:**
```
Help me refactor the codebase. First, list all TypeScript files. Then analyze each one for TODO comments.
```
```
I want to add a new feature: 1) create a config file, 2) update package.json, 3) write tests
```

**Special commands:**
```
/todos - Show current todo list
```

**What to observe:** The agent maintains a todo list and reminds you to keep it updated.

---

### s04_subagent.ts - Subagent Spawning

**Purpose:** Demonstrates spawning child agents with fresh context for isolated tasks.

**How to run:**
```bash
npx tsx s04_subagent.ts
```

**Recommended prompts:**
```
Delegate the task of counting all .ts files to a subagent
```
```
Create a subagent to analyze the project structure
```

**What to observe:** Subagents run independently and return summaries to the parent.

---

### s05_skill_loading.ts - Skill Loading

**Purpose:** Loads skills from SKILL.md files in the skills/ directory.

**How to run:**
```bash
npx tsx s05_skill_loading.ts
```

**Recommended prompts:**
```
What skills are available?
```
```
Load the skill for code review and use it
```

**What to observe:** Skills are listed in the system prompt. Full skill content is loaded on demand.

---

### s06_context_compact.ts - Context Compression

**Purpose:** Automatically compresses context when it exceeds token threshold.

**How to run:**
```bash
npx tsx s06_context_compact.ts
```

**Recommended prompts:**
```
Let's have a long conversation about the project structure. First, list all files. Then analyze each one...
```
```
/compact - Manually trigger compression
```

**What to observe:** When context grows large, older messages are summarized automatically.

---

### s07_permission_system.ts - Permission Gates

**Purpose:** Three permission modes: default (ask for writes), plan (ask for all tools), auto (allow non-destructive).

**How to run:**
```bash
npx tsx s07_permission_system.ts
```

**Recommended prompts:**
```
Delete the test.txt file
```
```
Read package.json
```

**Permission modes:**
- `default`: Ask for state-changing operations
- `plan`: Ask for all operations
- `auto`: Allow read operations, ask for writes

**What to observe:** Permission prompts appear based on the current mode.

---

### s08_hook_system.ts - Hook System

**Purpose:** Extensible hooks for PreToolUse, PostToolUse, and SessionStart events.

**How to run:**
```bash
npx tsx s08_hook_system.ts
```

**Recommended prompts:**
```
Run any bash command and observe the hook output
```

**Configuration:** Create `.hooks.json` to define custom hooks.

**What to observe:** Hooks fire before and after tool execution.

---

### s09_memory_system.ts - Memory System

**Purpose:** Persistent memory with four types: user, feedback, project, reference.

**How to run:**
```bash
npx tsx s09_memory_system.ts
```

**Recommended prompts:**
```
Remember that I prefer TypeScript over JavaScript
```
```
What do you know about my preferences?
```

**Memory files:** Stored in `.claude/projects/<hash>/memory/` with frontmatter.

**What to observe:** Memories persist across sessions and are loaded automatically.

---

### s10_system_prompt.ts - System Prompt Builder

**Purpose:** Constructs system prompt from multiple sections: core, tools, skills, memory, CLAUDE.md, dynamic context.

**How to run:**
```bash
npx tsx s10_system_prompt.ts
```

**Recommended prompts:**
```
/prompt - Show the full system prompt
```
```
/sections - Show section headers only
```
```
What tools do you have available?
```

**What to observe:** System prompt is built from a pipeline of sections.

---

### s11_error_recovery.ts - Error Recovery

**Purpose:** Handles API errors with exponential backoff retry logic.

**How to run:**
```bash
npx tsx s11_error_recovery.ts
```

**Recommended prompts:**
```
Test error handling by making a request
```

**What to observe:** The agent retries on transient errors with backoff.

---

### s12_task_system.ts - Task Management

**Purpose:** File-based task system with dependencies (blockedBy/blocks).

**How to run:**
```bash
npx tsx s12_task_system.ts
```

**Recommended prompts:**
```
Create a task to refactor the codebase
```
```
List all tasks and their dependencies
```

**Special commands:**
```
/tasks - Show task list
/task create <description> - Create new task
/task complete <id> - Mark task done
```

**What to observe:** Tasks are persisted to `.tasks/` directory.

---

### s13_background_tasks.ts - Background Execution

**Purpose:** Runs long-running commands asynchronously without blocking.

**How to run:**
```bash
npx tsx s13_background_tasks.ts
```

**Recommended prompts:**
```
Run a sleep command in the background for 5 seconds
```
```
Start a long build process and notify me when it finishes
```

**Special commands:**
```
/tasks - Check background task status
```

**What to observe:** Background tasks return immediately and notify on completion.

---

### s14_cron_scheduler.ts - Cron Scheduling

**Purpose:** Schedules prompts to run at specific times using 5-field cron expressions.

**How to run:**
```bash
npx tsx s14_cron_scheduler.ts
```

**Recommended prompts:**
```
Schedule a reminder to check tests every hour
```
```
Remind me at 3pm today to review the PR
```

**Special commands:**
```
/cron - List scheduled jobs
```

**Cron format:** `M H DoM Mon DoW` (e.g., `0 9 * * *` = 9am daily)

**What to observe:** Durable jobs persist to `.claude/scheduled_tasks.json`.

---

### s15_agent_teams.ts - Agent Teams

**Purpose:** Multi-agent collaboration via message bus with inbox system.

**How to run:**
```bash
npx tsx s15_agent_teams.ts
```

**Recommended prompts:**
```
Spawn a teammate to help with code review
```
```
Send a message to the reviewer agent
```

**Special commands:**
```
/team - Show team members
/inbox - Check messages
```

**What to observe:** Agents communicate through a shared message bus.

---

### s16_team_protocols.ts - Team Protocols

**Purpose:** Defines protocols for team communication (shutdown_request, plan_approval).

**How to run:**
```bash
npx tsx s16_team_protocols.ts
```

**Recommended prompts:**
```
Request a teammate to shutdown gracefully
```
```
Submit a plan for approval
```

**Protocol types:**
- `shutdown_request/shutdown_response` - Graceful shutdown
- `plan_approval` - Plan review with request_id correlation

**What to observe:** Structured protocol messages ensure reliable communication.

---

### s17_autonomous_agents.ts - Autonomous Agents

**Purpose:** Self-directed agents that claim tasks and poll when idle.

**How to run:**
```bash
npx tsx s17_autonomous_agents.ts
```

**Recommended prompts:**
```
Start an autonomous agent to monitor the task queue
```

**Special commands:**
```
/inbox - Check for new tasks
/claim - Claim a pending task
```

**What to observe:** Agents auto-claim tasks and re-inject identity after context compression.

---

### s18_worktree_task_isolation.ts - Worktree Isolation

**Purpose:** Git worktree integration for parallel task isolation.

**How to run:**
```bash
npx tsx s18_worktree_task_isolation.ts
```

**Recommended prompts:**
```
Create a worktree for a new feature branch
```
```
Run a task in an isolated worktree
```

**What to observe:** Each task runs in its own git worktree with isolated branch.

---

### s19_mcp_plugin.ts - MCP Integration

**Purpose:** Model Context Protocol integration for external tool servers.

**How to run:**
```bash
npx tsx s19_mcp_plugin.ts
```

**Recommended prompts:**
```
/tools - List all available tools including MCP
```
```
/mcp - Show MCP server status
```

**Special commands:**
```
/tools - Show tool catalog
/mcp - Show connected MCP servers
```

**MCP tool naming:** `mcp__{server}__{tool}` (e.g., `mcp__filesystem__read_file`)

**What to observe:** MCP tools are discovered and called alongside native tools.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Loop                               │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │  User    │───>│  Model   │───>│  Tools   │              │
│  │  Input   │    │  Reply   │    │  Execute │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│       ^                                |                    │
│       |________________________________|                    │
│              Tool Results                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Tool Registry                             │
│  Native: bash, read_file, write_file, edit_file             │
│  MCP: mcp__{server}__{tool}                                 │
│  Skills: Loaded from SKILL.md                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Support Systems                            │
│  Permission Gate  │  Memory     │  Hooks                     │
│  Task Manager     │  Cron       │  Message Bus               │
│  Worktree Mgr     │  Subagents  │  Context Compressor        │
└─────────────────────────────────────────────────────────────┘
```

## Progression Path

The examples build on each other:

1. **Foundation (s01-s02):** Agent loop and tool dispatch
2. **Planning (s03, s12-s13):** Todos, tasks, background execution
3. **Context (s04-s06, s10):** Subagents, skills, compression, system prompt
4. **Safety (s07-s08):** Permissions and hooks
5. **Persistence (s09, s14):** Memory and cron
6. **Recovery (s11):** Error handling
7. **Collaboration (s15-s17):** Teams, protocols, autonomous agents
8. **Isolation (s18):** Worktree for parallel work
9. **Integration (s19):** MCP plugin system

## Capstone Reference

`s_full.ts` combines all patterns into a single reference implementation. Use it as a guide for building a production agent.

## License

MIT
