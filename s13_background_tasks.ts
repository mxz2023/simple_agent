#!/usr/bin/env npx tsx
// Harness: background execution -- the model thinks while the harness waits.
/**
 * s13_background_tasks.ts - Background Tasks
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import * as crypto from "node:crypto";
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
const RUNTIME_DIR = path.join(WORKDIR, ".runtime-tasks");
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
});
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

const STALL_THRESHOLD_S = 45;

class NotificationQueue {
  static PRIORITIES: Record<string, number> = { immediate: 0, high: 1, medium: 2, low: 3 };

  private _queue: Array<[number, string | null, string]> = [];

  push(message: string, priority = "medium", key?: string | null): void {
    if (key) {
      this._queue = this._queue.filter(([, k]) => k !== key);
    }
    this._queue.push([NotificationQueue.PRIORITIES[priority] ?? 2, key ?? null, message]);
    this._queue.sort((a, b) => a[0] - b[0]);
  }

  drain(): string[] {
    const messages = this._queue.map(([, , m]) => m);
    this._queue = [];
    return messages;
  }
}

interface BgTask {
  id: string;
  status: string;
  result: string | null;
  command: string;
  started_at: number;
  finished_at: number | null;
  result_preview: string;
  output_file: string;
}

class BackgroundManager {
  dir: string;
  tasks: Record<string, BgTask> = {};
  private _notificationQueue: Array<Record<string, string>> = [];

  constructor() {
    this.dir = RUNTIME_DIR;
  }

  private _recordPath(taskId: string): string {
    return path.join(this.dir, `${taskId}.json`);
  }

  private _outputPath(taskId: string): string {
    return path.join(this.dir, `${taskId}.log`);
  }

  private _persistTask(taskId: string): void {
    const record = { ...this.tasks[taskId]! };
    fs.writeFileSync(this._recordPath(taskId), JSON.stringify(record, null, 2), "utf8");
  }

  private _preview(output: string, limit = 500): string {
    const compact = (output || "(no output)").split(/\s+/).join(" ");
    return compact.slice(0, limit);
  }

  run(command: string): string {
    const taskId = crypto.randomUUID().slice(0, 8);
    const outputFile = this._outputPath(taskId);
    this.tasks[taskId] = {
      id: taskId,
      status: "running",
      result: null,
      command,
      started_at: Date.now() / 1000,
      finished_at: null,
      result_preview: "",
      output_file: path.relative(WORKDIR, outputFile),
    };
    this._persistTask(taskId);

    const execAsync = promisify(exec);
    void execAsync(command, {
      cwd: WORKDIR,
      timeout: 300_000,
      maxBuffer: 50_000_000,
      shell: "/bin/sh",
    })
      .then(({ stdout, stderr }) => {
        const output = `${stdout}${stderr}`.trim().slice(0, 50_000);
        const status = "completed";
        const finalOutput = output || "(no output)";
        const preview = this._preview(finalOutput);
        fs.writeFileSync(outputFile, finalOutput, "utf8");
        this.tasks[taskId]!.status = status;
        this.tasks[taskId]!.result = finalOutput;
        this.tasks[taskId]!.finished_at = Date.now() / 1000;
        this.tasks[taskId]!.result_preview = preview;
        this._persistTask(taskId);
        this._notificationQueue.push({
          task_id: taskId,
          status,
          command: command.slice(0, 80),
          preview,
          output_file: path.relative(WORKDIR, outputFile),
        });
      })
      .catch((e: unknown) => {
        const msg = String((e as Error)?.message ?? e);
        const output = msg.includes("timeout") ? "Error: Timeout (300s)" : `Error: ${msg}`;
        const status = msg.includes("timeout") ? "timeout" : "error";
        const finalOutput = output;
        const preview = this._preview(finalOutput);
        fs.writeFileSync(outputFile, finalOutput, "utf8");
        this.tasks[taskId]!.status = status;
        this.tasks[taskId]!.result = finalOutput;
        this.tasks[taskId]!.finished_at = Date.now() / 1000;
        this.tasks[taskId]!.result_preview = preview;
        this._persistTask(taskId);
        this._notificationQueue.push({
          task_id: taskId,
          status,
          command: command.slice(0, 80),
          preview,
          output_file: path.relative(WORKDIR, outputFile),
        });
      });

    return (
      `Background task ${taskId} started: ${command.slice(0, 80)} ` +
      `(output_file=${path.relative(WORKDIR, outputFile)})`
    );
  }

  check(taskId?: string | null): string {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      const visible = {
        id: t.id,
        status: t.status,
        command: t.command,
        result_preview: t.result_preview ?? "",
        output_file: t.output_file ?? "",
      };
      return JSON.stringify(visible, null, 2);
    }
    const lines = Object.entries(this.tasks).map(
      ([tid, t]) =>
        `${tid}: [${t.status}] ${t.command.slice(0, 60)} -> ${t.result_preview || "(running)"}`,
    );
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  drainNotifications(): Array<Record<string, string>> {
    const notifs = [...this._notificationQueue];
    this._notificationQueue = [];
    return notifs;
  }

  detectStalled(): string[] {
    const now = Date.now() / 1000;
    const stalled: string[] = [];
    for (const [taskId, info] of Object.entries(this.tasks)) {
      if (info.status !== "running") continue;
      const elapsed = now - (info.started_at ?? now);
      if (elapsed > STALL_THRESHOLD_S) stalled.push(taskId);
    }
    return stalled;
  }
}

const BG = new BackgroundManager();

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
  background_run: (kw) => BG.run(String(kw.command)),
  check_background: (kw) => BG.check((kw.task_id as string | undefined) ?? undefined),
};

const TOOLS: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
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
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
];

async function agentLoop(messages: MessageParam[]): Promise<void> {
  while (true) {
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs
        .map(
          (n) =>
            `[bg:${n.task_id}] ${n.status}: ${n.preview} ` + `(output_file=${n.output_file})`,
        )
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
    }

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
      console.log(`> ${block.name}:`);
      console.log(String(output).slice(0, 200));
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
        query = await rl.question("\x1b[36ms13 >> \x1b[0m");
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
