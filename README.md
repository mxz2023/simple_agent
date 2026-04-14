# Simple Agent

A TypeScript-based learning project for Claude Code Agents, demonstrating 19 progressive agent patterns using the Anthropic SDK.

## Overview

This project contains 19 self-contained example files (s01-s19), each teaching a specific agent pattern:

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
- Anthropic API Key (or compatible endpoint)

## Installation

```bash
npm install
```

## Usage

Set your environment variables in `.env`:

```env
ANTHROPIC_API_KEY=your_api_key
MODEL_ID=claude-sonnet-4-5-20250929
```

Run any example:

```bash
npx tsx s01_agent_loop.ts
```

## Project Structure

```
ts/
├── __init__.ts           # Project initialization comment
├── s01_agent_loop.ts     # Basic agent loop
├── s02_tool_use.ts       # Tool dispatch
├── s03_todo_write.ts     # Session planning
├── s04_subagent.ts       # Subagent spawning
├── s05_skill_loading.ts  # Skill registry
├── s06_context_compact.ts # Context compression
├── s07_permission_system.ts # Permission gates
├── s08_hook_system.ts    # Hook system
├── s09_memory_system.ts  # Memory persistence
├── s10_system_prompt.ts  # System prompt builder
├── s11_error_recovery.ts # Error handling
├── s12_task_system.ts    # Task management
├── s13_background_tasks.ts # Async execution
├── s14_cron_scheduler.ts # Scheduled tasks
├── s15_agent_teams.ts    # Multi-agent teams
├── s16_team_protocols.ts # Team protocols
├── s17_autonomous_agents.ts # Autonomous agents
├── s18_worktree_task_isolation.ts # Worktree isolation
├── s19_mcp_plugin.ts     # MCP integration
├── s_full.ts             # Capstone reference
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
