#!/usr/bin/env npx tsx
// Harness: time -- the agent schedules its own future work.
/**
 * s14_cron_scheduler.ts - Cron / Scheduled Tasks
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID!;

const SCHEDULED_TASKS_FILE = path.join(WORKDIR, ".claude", "scheduled_tasks.json");
const AUTO_EXPIRY_DAYS = 7;
const JITTER_MINUTES = [0, 30];
const JITTER_OFFSET_MAX = 4;

function fieldMatches(field: string, value: number, lo: number, hi: number): boolean {
  if (field === "*") return true;

  for (const rawPart of field.split(",")) {
    let step = 1;
    let part = rawPart;
    if (part.includes("/")) {
      const [a, b] = part.split("/", 2);
      part = a!;
      step = Number(b);
    }

    if (part === "*") {
      if ((value - lo) % step === 0) return true;
    } else if (part.includes("-")) {
      const [startS, endS] = part.split("-", 2);
      const start = Number(startS);
      const end = Number(endS);
      if (start <= value && value <= end && (value - start) % step === 0) return true;
    } else {
      if (Number(part) === value) return true;
    }
  }
  return false;
}

function cronMatches(expr: string, dt: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = dt.getMinutes();
  const hour = dt.getHours();
  const dom = dt.getDate();
  const month = dt.getMonth() + 1;
  const cronDow = dt.getDay();
  const values = [minute, hour, dom, month, cronDow];
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];

  for (let i = 0; i < 5; i++) {
    const field = fields[i]!;
    const value = values[i]!;
    const [lo, hi] = ranges[i]!;
    if (!fieldMatches(field, value, lo, hi)) return false;
  }
  return true;
}

interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  jitter_offset?: number;
  last_fired?: number;
}

class CronScheduler {
  tasks: ScheduledTask[] = [];
  queue: string[] = [];
  private _stop = false;
  private _timer: NodeJS.Timeout | null = null;
  private _lastCheckMinute = -1;

  start(): void {
    this._loadDurable();
    this._timer = setInterval(() => this._tick(), 1000);
    const count = this.tasks.length;
    if (count) console.log(`[Cron] Loaded ${count} scheduled tasks`);
  }

  stop(): void {
    this._stop = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  create(cronExpr: string, prompt: string, recurring = true, durable = false): string {
    const taskId = crypto.randomUUID().slice(0, 8);
    const now = Date.now() / 1000;

    const task: ScheduledTask = {
      id: taskId,
      cron: cronExpr,
      prompt,
      recurring,
      durable,
      createdAt: now,
    };

    if (recurring) {
      task.jitter_offset = this._computeJitter(cronExpr);
    }

    this.tasks.push(task);
    if (durable) this._saveDurable();

    const mode = recurring ? "recurring" : "one-shot";
    const store = durable ? "durable" : "session-only";
    return `Created task ${taskId} (${mode}, ${store}): cron=${cronExpr}`;
  }

  delete(taskId: string): string {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    if (this.tasks.length < before) {
      this._saveDurable();
      return `Deleted task ${taskId}`;
    }
    return `Task ${taskId} not found`;
  }

  listTasks(): string {
    if (!this.tasks.length) return "No scheduled tasks.";
    const lines: string[] = [];
    for (const t of this.tasks) {
      const mode = t.recurring ? "recurring" : "one-shot";
      const store = t.durable ? "durable" : "session";
      const ageHours = (Date.now() / 1000 - t.createdAt) / 3600;
      lines.push(
        `  ${t.id}  ${t.cron}  [${mode}/${store}] (${ageHours.toFixed(1)}h old): ${t.prompt.slice(0, 60)}`,
      );
    }
    return lines.join("\n");
  }

  drainNotifications(): string[] {
    const notifications = [...this.queue];
    this.queue = [];
    return notifications;
  }

  private _computeJitter(cronExpr: string): number {
    const fields = cronExpr.trim().split(/\s+/);
    if (!fields.length) return 0;
    const minuteField = fields[0]!;
    const minuteVal = Number(minuteField);
    if (Number.isFinite(minuteVal) && JITTER_MINUTES.includes(minuteVal)) {
      let h = 0;
      for (let i = 0; i < cronExpr.length; i++) h = (h * 31 + cronExpr.charCodeAt(i)) >>> 0;
      return (h % JITTER_OFFSET_MAX) + 1;
    }
    return 0;
  }

  private _tick(): void {
    if (this._stop) return;
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (currentMinute !== this._lastCheckMinute) {
      this._lastCheckMinute = currentMinute;
      this._checkTasks(now);
    }
  }

  private _checkTasks(now: Date): void {
    const expired: string[] = [];
    const firedOneshots: string[] = [];

    for (const task of this.tasks) {
      const ageDays = (Date.now() / 1000 - task.createdAt) / 86_400;
      if (task.recurring && ageDays > AUTO_EXPIRY_DAYS) {
        expired.push(task.id);
        continue;
      }

      let checkTime = new Date(now);
      const jitter = task.jitter_offset ?? 0;
      if (jitter) {
        checkTime = new Date(checkTime.getTime() - jitter * 60_000);
      }

      if (cronMatches(task.cron, checkTime)) {
        const notification = `[Scheduled task ${task.id}]: ${task.prompt}`;
        this.queue.push(notification);
        task.last_fired = Date.now() / 1000;
        console.log(`[Cron] Fired: ${task.id}`);

        if (!task.recurring) {
          firedOneshots.push(task.id);
        }
      }
    }

    if (expired.length || firedOneshots.length) {
      const removeIds = new Set([...expired, ...firedOneshots]);
      this.tasks = this.tasks.filter((t) => !removeIds.has(t.id));
      for (const tid of expired) {
        console.log(`[Cron] Auto-expired: ${tid} (older than ${AUTO_EXPIRY_DAYS} days)`);
      }
      for (const tid of firedOneshots) {
        console.log(`[Cron] One-shot completed and removed: ${tid}`);
      }
      this._saveDurable();
    }
  }

  private _loadDurable(): void {
    if (!fs.existsSync(SCHEDULED_TASKS_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_FILE, "utf8")) as ScheduledTask[];
      this.tasks = data.filter((t) => t.durable);
    } catch (e) {
      console.log(`[Cron] Error loading tasks: ${e}`);
    }
  }

  detectMissedTasks(): Array<Record<string, string>> {
    const now = new Date();
    const missed: Array<Record<string, string>> = [];
    for (const task of this.tasks) {
      const lastFired = task.last_fired;
      if (lastFired == null) continue;
      const lastDt = new Date(lastFired * 1000);
      let check = new Date(lastDt.getTime() + 60_000);
      const cap = new Date(Math.min(now.getTime(), lastDt.getTime() + 24 * 60 * 60_000));
      while (check <= cap) {
        if (cronMatches(task.cron, check)) {
          missed.push({
            id: task.id,
            cron: task.cron,
            prompt: task.prompt,
            missed_at: check.toISOString(),
          });
          break;
        }
        check = new Date(check.getTime() + 60_000);
      }
    }
    return missed;
  }

  private _saveDurable(): void {
    const durable = this.tasks.filter((t) => t.durable);
    fs.mkdirSync(path.dirname(SCHEDULED_TASKS_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(durable, null, 2) + "\n", "utf8");
  }
}

const scheduler = new CronScheduler();

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
    const content = fs.readFileSync(fp, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
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
  cron_create: (kw) =>
    scheduler.create(String(kw.cron), String(kw.prompt), Boolean(kw.recurring ?? true), Boolean(kw.durable ?? false)),
  cron_delete: (kw) => scheduler.delete(String(kw.id)),
  cron_list: () => scheduler.listTasks(),
};

const TOOLS = convertTools([
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
    name: "cron_create",
    description: "Schedule a recurring or one-shot task with a cron expression.",
    input_schema: {
      type: "object",
      properties: {
        cron: { type: "string", description: "5-field cron expression: 'min hour dom month dow'" },
        prompt: { type: "string", description: "The prompt to inject when the task fires" },
        recurring: { type: "boolean", description: "true=repeat, false=fire once then delete. Default true." },
        durable: { type: "boolean", description: "true=persist to disk, false=session-only. Default false." },
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "cron_delete",
    description: "Delete a scheduled task by ID.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Task ID to delete" } },
      required: ["id"],
    },
  },
  {
    name: "cron_list",
    description: "List all scheduled tasks.",
    input_schema: { type: "object", properties: {} },
  },
]);

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You can schedule future work with cron_create. Tasks fire automatically and their prompts are injected into the conversation.`;

async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const notifications = scheduler.drainNotifications();
    for (const note of notifications) {
      console.log(`[Cron notification] ${note.slice(0, 100)}`);
      messages.push({ role: "user", content: note });
    }

    const response = await callChatCompletion(messages, TOOLS, SYSTEM);

    // 将工具调用转换为消息
    if (Array.isArray(response.content)) {
      messages.push({ role: "assistant", content: JSON.stringify(response.content) });
    } else {
      messages.push({ role: "assistant", content: response.content });
    }

    if (!hasToolCalls(response)) return;

    const toolCalls = response.content as Array<{ id: string; function: { name: string; arguments: string } }>;
    const results: Message[] = [];

    for (const call of toolCalls) {
      const handler = TOOL_HANDLERS[call.function.name];
      let output: string;
      try {
        output = handler ? handler(getToolCallArgs(call)) : `Unknown: ${call.function.name}`;
      } catch (e) {
        output = `Error: ${e}`;
      }
      console.log(`> ${call.function.name}: ${output.slice(0, 200)}`);
      results.push({ role: "tool", tool_call_id: call.id, content: String(output) });
    }

    messages.push(...results);
  }
}

async function main(): Promise<void> {
  scheduler.start();
  console.log("[Cron scheduler running. Background checks every second.]");
  console.log("[Commands: /cron to list tasks, /test to fire a test notification]");

  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms14 >> \x1b[0m");
      } catch {
        scheduler.stop();
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") {
        scheduler.stop();
        break;
      }

      if (query.trim() === "/cron") {
        console.log(scheduler.listTasks());
        continue;
      }

      if (query.trim() === "/test") {
        scheduler.queue.push("[Scheduled task test-0000]: This is a test notification.");
        console.log("[Test notification enqueued. It will be injected on your next message.]");
        continue;
      }

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
    scheduler.stop();
    rl.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main();
}
