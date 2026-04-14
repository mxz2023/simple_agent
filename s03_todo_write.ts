#!/usr/bin/env npx tsx
// Harness: planning -- keep the current session plan outside the model's head.
/**
 * s03_todo_write.ts - Session Planning with TodoWrite
 *
 * This chapter is about a lightweight session plan, not a durable task graph.
 * The model can rewrite its current plan, keep one active step in focus, and get
 * nudged if it stops refreshing the plan for too many rounds.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
});
const MODEL = process.env.MODEL_ID!;
const PLAN_REMINDER_INTERVAL = 3;

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;

interface PlanItem {
  content: string;
  status: string;
  activeForm: string;
}

interface PlanningState {
  items: PlanItem[];
  roundsSinceUpdate: number;
}

class TodoManager {
  state: PlanningState = { items: [], roundsSinceUpdate: 0 };

  update(items: Record<string, unknown>[]): string {
    if (items.length > 12) {
      throw new Error("Keep the session plan short (max 12 items)");
    }
    const normalized: PlanItem[] = [];
    let inProgressCount = 0;
    for (let index = 0; index < items.length; index++) {
      const rawItem = items[index]!;
      const content = String(rawItem.content ?? "").trim();
      const status = String(rawItem.status ?? "pending").toLowerCase();
      const activeForm = String(rawItem.activeForm ?? "").trim();

      if (!content) {
        throw new Error(`Item ${index}: content required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (status === "in_progress") inProgressCount += 1;

      normalized.push({ content, status, activeForm });
    }
    if (inProgressCount > 1) {
      throw new Error("Only one plan item can be in_progress");
    }
    this.state.items = normalized;
    this.state.roundsSinceUpdate = 0;
    return this.render();
  }

  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate += 1;
  }

  reminder(): string | null {
    if (!this.state.items.length) return null;
    if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) return null;
    return "<reminder>Refresh your current plan before continuing.</reminder>";
  }

  render(): string {
    if (!this.state.items.length) return "No session plan yet.";

    const lines: string[] = [];
    for (const item of this.state.items) {
      const marker =
        item.status === "pending"
          ? "[ ]"
          : item.status === "in_progress"
            ? "[>]"
            : item.status === "completed"
              ? "[x]"
              : "[?]";
      let line = `${marker} ${item.content}`;
      if (item.status === "in_progress" && item.activeForm) {
        line += ` (${item.activeForm})`;
      }
      lines.push(line);
    }
    const completed = this.state.items.filter((i) => i.status === "completed").length;
    lines.push(`\n(${completed}/${this.state.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

function safePath(pathStr: string): string {
  const resolved = path.resolve(WORKDIR, pathStr);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 50_000_000,
    });
    const s = String(out).trim();
    return s ? s.slice(0, 50_000) : "(no output)";
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const msg = String(err?.message ?? e);
    if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) {
      return "Error: Timeout (120s)";
    }
    return `Error: ${msg}`;
  }
}

function runRead(filePath: string, limit?: number | null): string {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    let outLines = lines;
    if (limit != null && limit < lines.length) {
      outLines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return outLines.join("\n").slice(0, 50_000);
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => runBash(String(kw.command)),
  read_file: (kw) => runRead(String(kw.path), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  todo: (kw) => TODO.update((kw.items as Record<string, unknown>[]) ?? []),
};

const TOOLS: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "todo",
    description: "Rewrite the current session plan for multi-step work.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: {
                type: "string",
                description: "Optional present-continuous label.",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as { text?: string }[]) {
    if (block?.text) texts.push(block.text);
  }
  return texts.join("\n").trim();
}

async function agentLoop(messages: MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: (Anthropic.Messages.ToolResultBlockParam | Anthropic.Messages.TextBlockParam)[] = [];
    let usedTodo = false;
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const handler = TOOL_HANDLERS[block.name];
      let out: string;
      try {
        out = handler ? handler((block.input ?? {}) as Record<string, unknown>) : `Unknown tool: ${block.name}`;
      } catch (exc) {
        out = `Error: ${exc}`;
      }

      console.log(`> ${block.name}: ${out.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      if (block.name === "todo") usedTodo = true;
    }

    if (usedTodo) {
      TODO.state.roundsSinceUpdate = 0;
    } else {
      TODO.noteRoundWithoutUpdate();
      const reminder = TODO.reminder();
      if (reminder) {
        results.unshift({ type: "text", text: reminder });
      }
    }

    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  const history: MessageParam[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms03 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      history.push({ role: "user", content: query });
      await agentLoop(history);

      const last = history[history.length - 1];
      const finalText = extractText(last?.content);
      if (finalText) console.log(finalText);
      console.log();
    }
  } finally {
    rl.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main();
}
