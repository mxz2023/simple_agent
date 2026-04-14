#!/usr/bin/env npx tsx
// Harness: all mechanisms combined -- the complete cockpit for the model.
/**
 * s_full.ts - Capstone Teaching Agent
 *
 * Combines mechanisms from s01–s18 into one runnable agent (local core).
 * s19 (MCP) stays a separate chapter in this curriculum.
 */

import * as crypto from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });
const MODEL = process.env.MODEL_ID!;

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100_000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const TASK_OUTPUT_DIR = path.join(WORKDIR, ".task_outputs");
const TOOL_RESULTS_DIR = path.join(TASK_OUTPUT_DIR, "tool-results");
const PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT = 50_000;
const PERSIST_OUTPUT_TRIGGER_CHARS_BASH = 30_000;
const CONTEXT_TRUNCATE_CHARS = 50_000;
const PERSISTED_OPEN = "<persisted-output>";
const PERSISTED_CLOSE = "</persisted-output>";
const PERSISTED_PREVIEW_CHARS = 2000;
const KEEP_RECENT = 3;
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

const VALID_MSG_TYPES = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const;

function jsonStringifySafe(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function previewSlice(text: string, limit: number): [string, boolean] {
  if (text.length <= limit) return [text, false];
  const idx = text.slice(0, limit).lastIndexOf("\n");
  const cut = idx > limit * 0.5 ? idx : limit;
  return [text.slice(0, cut), true];
}

function persistToolResult(toolUseId: string, content: string): string {
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const safeId = (toolUseId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const fp = path.join(TOOL_RESULTS_DIR, `${safeId}.txt`);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, content, "utf8");
  return path.relative(WORKDIR, fp);
}

function buildPersistedMarker(storedPath: string, content: string): string {
  const [preview, hasMore] = previewSlice(content, PERSISTED_PREVIEW_CHARS);
  let marker =
    `${PERSISTED_OPEN}\n` +
    `Output too large (${formatSize(content.length)}). ` +
    `Full output saved to: ${storedPath}\n\n` +
    `Preview (first ${formatSize(PERSISTED_PREVIEW_CHARS)}):\n` +
    `${preview}`;
  if (hasMore) marker += "\n...";
  marker += `\n${PERSISTED_CLOSE}`;
  return marker;
}

function maybePersistOutput(toolUseId: string, output: string, triggerChars?: number): string {
  const trigger = triggerChars ?? PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT;
  if (output.length <= trigger) return output;
  const storedPath = persistToolResult(toolUseId, output);
  return buildPersistedMarker(storedPath, output);
}

function runBash(command: string, toolUseId = ""): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const out = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 50_000_000,
    });
    let s = String(out).trim() || "(no output)";
    s = maybePersistOutput(toolUseId, s, PERSIST_OUTPUT_TRIGGER_CHARS_BASH);
    return s.slice(0, CONTEXT_TRUNCATE_CHARS);
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const msg = String(err?.message ?? e);
    if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) return "Error: Timeout (120s)";
    return `Error: ${msg}`;
  }
}

function runRead(filePath: string, toolUseId = "", limit?: number | null): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    let out = lines.join("\n");
    out = maybePersistOutput(toolUseId, out);
    return out.slice(0, CONTEXT_TRUNCATE_CHARS);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

interface TodoItem {
  content: string;
  status: string;
  activeForm: string;
}

class TodoManager {
  items: TodoItem[] = [];

  update(items: Record<string, unknown>[]): string {
    const validated: TodoItem[] = [];
    let ip = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const content = String(item.content ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();
      const activeForm = String(item.activeForm ?? "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") ip += 1;
      validated.push({ content, status, activeForm });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (ip > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const lines: string[] = [];
    for (const item of this.items) {
      const m =
        item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : item.status === "pending" ? "[ ]" : "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${m} ${item.content}${suffix}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

async function runSubagent(prompt: string, agentType = "Explore"): Promise<string> {
  const subTools: Tool[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
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
    );
  }
  const subHandlers: Record<string, (input: Record<string, unknown>) => string> = {
    bash: (kw) => runBash(String(kw.command)),
    read_file: (kw) => runRead(String(kw.path)),
    write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
    edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  };
  const subMsgs: Message[] = [{ role: "user", content: prompt }];
  let resp: Awaited<ReturnType<typeof callChatCompletion>> | null = null;
  for (let i = 0; i < 30; i++) {
    resp = await callChatCompletion(subMsgs, subTools, "You are a subagent exploring or working on tasks.");
    subMsgs.push({ role: "assistant", content: resp.content });
    if (!hasToolCalls(resp)) break;
    const toolCalls = resp.content as Array<{ id: string; function: { name: string; arguments: string } }>;
    const results: Message[] = [];
    for (const call of toolCalls) {
      const h = subHandlers[call.function.name];
      const out = h ? h(getToolCallArgs(call)) : "Unknown tool";
      results.push({ role: "tool", tool_call_id: call.id, content: String(out).slice(0, 50_000) });
    }
    subMsgs.push(...results);
  }
  if (!resp) return "(subagent failed)";
  if (Array.isArray(resp.content)) {
    const textBlocks = resp.content.filter((b): b is { type: "text"; text: string } => "type" in b && b.type === "text" && typeof b.text === "string");
    return textBlocks.map((b) => b.text).join("") || "(no summary)";
  }
  return String(resp.content) || "(no summary)";
}

class SkillLoader {
  skills: Record<string, { meta: Record<string, string>; body: string }> = {};

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else out.push(p);
      }
      return out;
    };
    for (const f of walk(skillsDir).filter((p) => path.basename(p) === "SKILL.md").sort()) {
      const text = fs.readFileSync(f, "utf8");
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)/.exec(text);
      let meta: Record<string, string> = {};
      let body = text;
      if (match) {
        for (const line of match[1]!.trim().split(/\r?\n/)) {
          const idx = line.indexOf(":");
          if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        body = match[2]!.trim();
      }
      const name = meta.name ?? path.basename(path.dirname(f));
      this.skills[name] = { meta, body };
    }
  }

  descriptions(): string {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills)
      .map(([n, s]) => `  - ${n}: ${s.meta.description ?? "-"}`)
      .join("\n");
  }

  load(name: string): string {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

function estimateTokens(messages: Message[]): number {
  return Math.floor(jsonStringifySafe(messages).length / 4);
}

function microcompact(messages: Message[]): void {
  const toolResults: Array<{ block: { tool_call_id?: string; content?: unknown } }> = [];
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    toolResults.push({ block: { tool_call_id: msg.tool_call_id, content: msg.content } });
  }
  if (toolResults.length <= KEEP_RECENT) return;
  for (const { block } of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof block.content !== "string" || block.content.length <= 100) continue;
    block.content = `[Previous tool result]`;
  }
}

async function autoCompact(messages: Message[], focus?: string | null): Promise<Message[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(p, messages.map((m) => jsonStringifySafe(m)).join("\n") + "\n", "utf8");
  const convText = jsonStringifySafe(messages).slice(0, 80_000);
  let prompt =
    "Summarize this conversation for continuity. Structure your summary:\n" +
    "1) Task overview: core request, success criteria, constraints\n" +
    "2) Current state: completed work, files touched, artifacts created\n" +
    "3) Key decisions and discoveries: constraints, errors, failed approaches\n" +
    "4) Next steps: remaining actions, blockers, priority order\n" +
    "5) Context to preserve: user preferences, domain details, commitments\n" +
    "Be concise but preserve critical details.\n";
  if (focus) prompt += `\nPay special attention to: ${focus}\n`;
  const resp = await callChatCompletion([{ role: "user", content: prompt + "\n" + convText }], [], "Summarize this conversation for continuity.");
  const summary = Array.isArray(resp.content)
    ? resp.content.filter((b): b is { type: "text"; text: string } => "type" in b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
    : String(resp.content);
  const continuation =
    "This session is being continued from a previous conversation that ran out " +
    "of context. The summary below covers the earlier portion of the conversation.\n\n" +
    `${summary}\n\n` +
    "Please continue the conversation from where we left it off without asking " +
    "the user any further questions.";
  return [{ role: "user", content: continuation }];
}

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

class TaskManager {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private _nextId(): number {
    const ids = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .map((f) => Number(f.slice("task_".length, -".json".length)))
      .filter((n) => Number.isFinite(n));
    return ids.length ? Math.max(...ids) + 1 : 1;
  }

  private _path(tid: number): string {
    return path.join(this.dir, `task_${tid}.json`);
  }

  private _load(tid: number): TaskRecord {
    const p = this._path(tid);
    if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(p, "utf8")) as TaskRecord;
  }

  private _save(task: TaskRecord): void {
    fs.writeFileSync(this._path(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  create(subject: string, description = ""): string {
    const task: TaskRecord = {
      id: this._nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this._load(tid), null, 2);
  }

  update(
    tid: number,
    status?: string | null,
    addBlockedBy?: number[] | null,
    addBlocks?: number[] | null,
  ): string {
    const task = this._load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const f of fs.readdirSync(this.dir)) {
          if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
          const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as TaskRecord;
          if (t.blockedBy?.includes(tid)) {
            t.blockedBy = t.blockedBy.filter((x) => x !== tid);
            this._save(t);
          }
        }
      }
      if (status === "deleted") {
        fs.unlinkSync(this._path(tid));
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
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
      const m =
        t.status === "pending"
          ? "[ ]"
          : t.status === "in_progress"
            ? "[>]"
            : t.status === "completed"
              ? "[x]"
              : "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy?.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      lines.push(`${m} #${t.id}: ${t.subject}${owner}${blocked}`);
    }
    return lines.join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this._load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this._save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}

const execAsync = promisify(exec);

class BackgroundManager {
  tasks: Record<string, { status: string; command: string; result: string | null }> = {};
  notifications: Array<{ task_id: string; status: string; result: string }> = [];

  run(command: string, timeout = 120): string {
    const tid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    this.tasks[tid] = { status: "running", command, result: null };
    void execAsync(command, {
      cwd: WORKDIR,
      timeout: timeout * 1000,
      maxBuffer: 50_000_000,
      shell: "/bin/sh",
    })
      .then(({ stdout, stderr }) => {
        const output = `${stdout}${stderr}`.trim().slice(0, 50_000);
        const rec = this.tasks[tid];
        if (rec) {
          rec.status = "completed";
          rec.result = output || "(no output)";
        }
        this.notifications.push({
          task_id: tid,
          status: "completed",
          result: (output || "(no output)").slice(0, 500),
        });
      })
      .catch((e: unknown) => {
        const msg = String(e);
        const rec = this.tasks[tid];
        if (rec) {
          rec.status = "error";
          rec.result = msg;
        }
        this.notifications.push({ task_id: tid, status: "error", result: msg.slice(0, 500) });
      });
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  check(tid?: string | null): string {
    if (tid) {
      const t = this.tasks[tid];
      return t ? `[${t.status}] ${t.result ?? "(running)"}` : `Unknown: ${tid}`;
    }
    const entries = Object.entries(this.tasks);
    if (!entries.length) return "No bg tasks.";
    return entries.map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`).join("\n");
  }

  drain(): Array<{ task_id: string; status: string; result: string }> {
    const n = [...this.notifications];
    this.notifications = [];
    return n;
  }
}

class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    const msg: Record<string, unknown> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): unknown[] {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const raw = fs.readFileSync(inboxPath, "utf8").trim();
    const msgs = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    fs.writeFileSync(inboxPath, "", "utf8");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) {
      if (n !== sender) {
        this.send(sender, n, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const shutdownRequests: Record<string, { target: string; status: string }> = {};
const planRequests: Record<string, { from: string; status?: string }> = {};

class TeammateManager {
  configPath: string;
  config: { team_name: string; members: { name: string; role: string; status: string }[] };

  constructor(
    private readonly bus: MessageBus,
    private readonly taskMgr: TaskManager,
  ) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this._load();
  }

  private _load(): { team_name: string; members: { name: string; role: string; status: string }[] } {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8")) as typeof this.config;
    }
    return { team_name: "default", members: [] };
  }

  private _save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  private _find(name: string): { name: string; role: string; status: string } | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private _setStatus(name: string, status: string): void {
    const m = this._find(name);
    if (m) {
      m.status = status;
      this._save();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._save();
    void this._loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private async _loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle when done with current work. You may auto-claim tasks.`;
    const messages: Message[] = [{ role: "user", content: prompt }];
    const tools = convertTools([
      {
        name: "bash",
        description: "Run command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "Read file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
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
        name: "send_message",
        description: "Send message.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" } },
          required: ["to", "content"],
        },
      },
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object", properties: {} } },
      {
        name: "claim_task",
        description: "Claim task by ID.",
        input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
      },
    ]);

    while (true) {
      for (let i = 0; i < 50; i++) {
        const inbox = this.bus.readInbox(name) as Record<string, unknown>[];
        for (const msg of inbox) {
          if ((msg as { type?: string }).type === "shutdown_request") {
            this._setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response;
        try {
          response = await callChatCompletion(messages, tools, sysPrompt);
        } catch {
          this._setStatus(name, "shutdown");
          return;
        }

        // 将工具调用转换为消息
        if (Array.isArray(response.content)) {
          messages.push({ role: "assistant", content: JSON.stringify(response.content) });
        } else {
          messages.push({ role: "assistant", content: response.content });
        }

        if (!hasToolCalls(response)) break;

        const toolCalls = response.content as Array<{ id: string; function: { name: string; arguments: string } }>;
        const results: Message[] = [];
        let idleRequested = false;

        for (const call of toolCalls) {
          const toolName = call.function.name;
          let output: string;
          if (toolName === "idle") {
            idleRequested = true;
            output = "Entering idle phase.";
          } else if (toolName === "claim_task") {
            output = this.taskMgr.claim(Number((getToolCallArgs(call) as { task_id: number }).task_id), name);
          } else if (toolName === "send_message") {
            const inp = getToolCallArgs(call) as { to: string; content: string };
            output = this.bus.send(name, inp.to, inp.content);
          } else {
            const dispatch: Record<string, (kw: Record<string, unknown>) => string> = {
              bash: (kw) => runBash(String(kw.command)),
              read_file: (kw) => runRead(String(kw.path)),
              write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
              edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
            };
            const fn = dispatch[toolName];
            output = fn ? fn(getToolCallArgs(call)) : "Unknown";
          }
          console.log(`  [${name}] ${toolName}: ${String(output).slice(0, 120)}`);
          results.push({ role: "tool", tool_call_id: call.id, content: String(output) });
        }
        messages.push(...results);
        if (idleRequested) break;
      }

      this._setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let p = 0; p < polls; p++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));
        const inbox = this.bus.readInbox(name) as Record<string, unknown>[];
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this._setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }
        const unclaimed: TaskRecord[] = [];
        for (const f of fs.readdirSync(TASKS_DIR).filter((x) => x.startsWith("task_") && x.endsWith(".json")).sort()) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as TaskRecord;
          if (t.status === "pending" && !t.owner && (!t.blockedBy || !t.blockedBy.length)) {
            unclaimed.push(t);
          }
        }
        if (unclaimed.length) {
          const task = unclaimed[0]!;
          this.taskMgr.claim(task.id, name);
          if (messages.length <= 3) {
            messages.splice(0, 0, {
              role: "user",
              content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
            });
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>`,
          });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }
      if (!resume) {
        this._setStatus(name, "shutdown");
        return;
      }
      this._setStatus(name, "working");
    }
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager(TASKS_DIR);
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

function handleShutdownRequest(teammate: string): string {
  const reqId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string | Promise<string>> = {
  bash: async (kw) => runBash(String(kw.command), String(kw.tool_use_id ?? "")),
  read_file: async (kw) => runRead(String(kw.path), String(kw.tool_use_id ?? ""), kw.limit as number | undefined),
  write_file: async (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: async (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  TodoWrite: async (kw) => TODO.update((kw.items as Record<string, unknown>[]) ?? []),
  task: async (kw) => runSubagent(String(kw.prompt), String(kw.agent_type ?? "Explore")),
  load_skill: async (kw) => SKILLS.load(String(kw.name)),
  compress: async () => "Compressing...",
  background_run: async (kw) => BG.run(String(kw.command), (kw.timeout as number | undefined) ?? 120),
  check_background: async (kw) => BG.check((kw.task_id as string | undefined) ?? undefined),
  task_create: async (kw) => TASK_MGR.create(String(kw.subject), String(kw.description ?? "")),
  task_get: async (kw) => TASK_MGR.get(Number(kw.task_id)),
  task_update: async (kw) =>
    TASK_MGR.update(
      Number(kw.task_id),
      (kw.status as string | undefined) ?? undefined,
      (kw.add_blocked_by as number[] | undefined) ?? undefined,
      (kw.add_blocks as number[] | undefined) ?? undefined,
    ),
  task_list: async () => TASK_MGR.listAll(),
  spawn_teammate: async (kw) => TEAM.spawn(String(kw.name), String(kw.role), String(kw.prompt)),
  list_teammates: async () => TEAM.listAll(),
  send_message: async (kw) => BUS.send("lead", String(kw.to), String(kw.content), String(kw.msg_type ?? "message")),
  read_inbox: async () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: async (kw) => BUS.broadcast("lead", String(kw.content), TEAM.memberNames()),
  shutdown_request: async (kw) => handleShutdownRequest(String(kw.teammate)),
  plan_approval: async (kw) => handlePlanReview(String(kw.request_id), Boolean(kw.approve), String(kw.feedback ?? "")),
  idle: async () => "Lead does not idle.",
  claim_task: async (kw) => TASK_MGR.claim(Number(kw.task_id), "lead"),
};

const TOOLS_RAW: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
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
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description: "Spawn a subagent for isolated exploration or work.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent_type: { type: "string", enum: ["Explore", "general-purpose"] },
      },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {} } },
  {
    name: "background_run",
    description: "Run command in background thread.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "integer" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "task_create",
    description: "Create a persistent file task.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "task_update",
    description: "Update task status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocked_by: { type: "array", items: { type: "integer" } },
        add_blocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent autonomous teammate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
      },
      required: ["to", "content"],
    },
  },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  {
    name: "broadcast",
    description: "Send message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  {
    name: "claim_task",
    description: "Claim a task from the board.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

const TOOLS = convertTools(TOOLS_RAW);

async function agentLoop(messages: Message[]): Promise<void> {
  let roundsWithoutTodo = 0;
  while (true) {
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const replacement = await autoCompact(messages);
      messages.length = 0;
      messages.push(...replacement);
    }
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
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
    let usedTodo = false;
    let manualCompress = false;
    let compactFocus: string | null = null;

    for (const call of toolCalls) {
      const toolName = call.function.name;
      if (toolName === "compress") {
        manualCompress = true;
        compactFocus = ((getToolCallArgs(call) as { focus?: string }).focus) ?? null;
      }
      const handler = TOOL_HANDLERS[toolName];
      let output: string;
      try {
        const toolInput = { ...getToolCallArgs(call), tool_use_id: call.id };
        output = String(handler ? await handler(toolInput) : `Unknown tool: ${toolName}`);
      } catch (e) {
        output = `Error: ${e}`;
      }
      console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      results.push({ role: "tool", tool_call_id: call.id, content: output });
      if (toolName === "TodoWrite") usedTodo = true;
    }
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ role: "user", content: "<reminder>Update your todos.</reminder>" });
    }
    messages.push(...results);
    if (manualCompress) {
      console.log("[manual compact]");
      const replacement = await autoCompact(messages, compactFocus);
      messages.length = 0;
      messages.push(...replacement);
    }
  }
}

async function main(): Promise<void> {
  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms_full >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;
      if (query.trim() === "/compact") {
        if (history.length) {
          console.log("[manual compact via /compact]");
          const replacement = await autoCompact(history);
          history.length = 0;
          history.push(...replacement);
        }
        continue;
      }
      if (query.trim() === "/tasks") {
        console.log(TASK_MGR.listAll());
        continue;
      }
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);
      console.log();
    }
  } finally {
    rl.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
