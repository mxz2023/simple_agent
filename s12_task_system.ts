#!/usr/bin/env npx tsx
// Harness: persistent tasks -- goals that outlive any single conversation.
/**
 * s12_task_system.ts - Tasks
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

class TaskManager {
  dir: string;
  private _nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  private _maxId(): number {
    const ids = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .map((f) => Number(f.slice("task_".length, -".json".length)))
      .filter((n) => Number.isFinite(n));
    return ids.length ? Math.max(...ids) : 0;
  }

  private _path(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private _load(taskId: number): TaskRecord {
    const p = this._path(taskId);
    if (!fs.existsSync(p)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(p, "utf8")) as TaskRecord;
  }

  private _save(task: TaskRecord): void {
    fs.writeFileSync(this._path(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  create(subject: string, description = ""): string {
    const task: TaskRecord = {
      id: this._nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this._save(task);
    this._nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  update(
    taskId: number,
    status?: string | null,
    owner?: string | null,
    addBlockedBy?: number[] | null,
    addBlocks?: number[] | null,
  ): string {
    const task = this._load(taskId);
    if (owner != null) task.owner = owner;
    if (status) {
      if (!["pending", "in_progress", "completed", "deleted"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskRecord["status"];
      if (status === "completed") {
        this._clearDependency(taskId);
      }
    }
    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this._save(blocked);
          }
        } catch {
          /* ignore missing */
        }
      }
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  private _clearDependency(completedId: number): void {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord;
      if (task.blockedBy?.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this._save(task);
      }
    }
  }

  listAll(): string {
    const tasks = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord);
    if (!tasks.length) return "No tasks.";
    const lines: string[] = [];
    for (const t of tasks) {
      const marker =
        t.status === "pending"
          ? "[ ]"
          : t.status === "in_progress"
            ? "[>]"
            : t.status === "completed"
              ? "[x]"
              : t.status === "deleted"
                ? "[-]"
                : "[?]";
      const blocked = t.blockedBy?.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${blocked}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
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
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => runBash(String(kw.command)),
  read_file: (kw) => runRead(String(kw.path), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  task_create: (kw) => TASKS.create(String(kw.subject), String(kw.description ?? "")),
  task_update: (kw) =>
    TASKS.update(
      Number(kw.task_id),
      kw.status as string | undefined,
      kw.owner as string | undefined,
      kw.addBlockedBy as number[] | undefined,
      kw.addBlocks as number[] | undefined,
    ),
  task_list: () => TASKS.listAll(),
  task_get: (kw) => TASKS.get(Number(kw.task_id)),
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
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
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
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status, owner, or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        owner: { type: "string", description: "Set when a teammate claims the task" },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

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

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler((block.input ?? {}) as Record<string, unknown>) : `Unknown tool: ${block.name}`;
      } catch (e) {
        output = `Error: ${e}`;
      }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
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
        query = await rl.question("\x1b[36ms12 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;
      history.push({ role: "user", content: query });
      await agentLoop(history);
      const responseContent = history[history.length - 1]?.content;
      if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
          if ("text" in block && typeof (block as { text?: string }).text === "string") {
            console.log((block as { text: string }).text);
          }
        }
      }
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
