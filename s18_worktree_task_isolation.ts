#!/usr/bin/env npx tsx
// Harness: directory isolation -- parallel execution lanes that never collide.
/**
 * s18_worktree_task_isolation.ts - Worktree + Task Isolation
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;

const WORKDIR = process.cwd();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
});
const MODEL = process.env.MODEL_ID!;

function detectRepoRoot(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    const root = r.stdout.trim();
    return r.status === 0 && root && fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) ?? WORKDIR;

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout.";

class EventBus {
  constructor(private readonly eventLogPath: string) {
    fs.mkdirSync(path.dirname(this.eventLogPath), { recursive: true });
    if (!fs.existsSync(this.eventLogPath)) fs.writeFileSync(this.eventLogPath, "", "utf8");
  }

  emit(event: string, extra: Record<string, unknown> = {}): void {
    const payload: Record<string, unknown> = { event, ts: Date.now() / 1000, ...extra };
    fs.appendFileSync(this.eventLogPath, JSON.stringify(payload) + "\n", "utf8");
  }

  listRecent(limit?: number | null): string {
    const n = Math.max(1, Math.min(Number(limit ?? 20) || 20, 200));
    const lines = fs.readFileSync(this.eventLogPath, "utf8").split(/\r?\n/).filter(Boolean);
    const items: unknown[] = [];
    for (const line of lines.slice(-n)) {
      try {
        items.push(JSON.parse(line) as unknown);
      } catch {
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string;
  worktree: string;
  worktree_state: string;
  last_worktree: string;
  closeout: unknown;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
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
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
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
      owner: "",
      worktree: "",
      worktree_state: "unbound",
      last_worktree: "",
      closeout: null,
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this._save(task);
    this._nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this._path(taskId));
  }

  update(taskId: number, status?: string | null, owner?: string | null): string {
    const task = this._load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed", "deleted"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskRecord["status"];
    }
    if (owner !== undefined && owner !== null) task.owner = owner;
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner = ""): string {
    const task = this._load(taskId);
    task.worktree = worktree;
    task.last_worktree = worktree;
    task.worktree_state = "active";
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  recordCloseout(taskId: number, action: string, reason = "", keepBinding = false): string {
    const task = this._load(taskId);
    task.closeout = { action, reason, at: Date.now() / 1000 };
    task.worktree_state = action;
    if (!keepBinding) task.worktree = "";
    task.updated_at = Date.now() / 1000;
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
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

class WorktreeManager {
  repoRoot: string;
  tasks: TaskManager;
  events: EventBus;
  dir: string;
  indexPath: string;
  gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf8");
    }
    this.gitAvailable = this._checkGit();
  }

  private _checkGit(): boolean {
    try {
      const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.repoRoot,
        encoding: "utf8",
        timeout: 10_000,
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  private _runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error("Not in a git repository.");
    const r = spawnSync("git", args, {
      cwd: this.repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(String(r.stdout + r.stderr).trim() || `git ${args.join(" ")} failed`);
    }
    return String(r.stdout + r.stderr).trim() || "(no output)";
  }

  private _loadIndex(): { worktrees: Array<Record<string, unknown>> } {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as { worktrees: Array<Record<string, unknown>> };
  }

  private _saveIndex(data: { worktrees: Array<Record<string, unknown>> }): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf8");
  }

  private _find(name: string): Record<string, unknown> | undefined {
    return this._loadIndex().worktrees.find((wt) => wt.name === name);
  }

  private _updateEntry(name: string, changes: Record<string, unknown>): Record<string, unknown> {
    const idx = this._loadIndex();
    let updated: Record<string, unknown> | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        Object.assign(item, changes);
        updated = item;
        break;
      }
    }
    this._saveIndex(idx);
    if (!updated) throw new Error(`Worktree '${name}' not found in index`);
    return updated;
  }

  private _validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, digits, ., _, -");
    }
  }

  create(name: string, taskId?: number | null, baseRef = "HEAD"): string {
    this._validateName(name);
    if (this._find(name)) throw new Error(`Worktree '${name}' already exists`);
    if (taskId != null && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit("worktree.create.before", { task_id: taskId, wt_name: name });
    try {
      this._runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);
      const entry: Record<string, unknown> = {
        name,
        path: wtPath,
        branch,
        task_id: taskId ?? undefined,
        status: "active",
        created_at: Date.now() / 1000,
      };
      const idx = this._loadIndex();
      idx.worktrees.push(entry);
      this._saveIndex(idx);
      if (taskId != null) this.tasks.bindWorktree(taskId, name);
      this.events.emit("worktree.create.after", { task_id: taskId, wt_name: name });
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit("worktree.create.failed", { task_id: taskId, wt_name: name, error: String(e) });
      throw e;
    }
  }

  listAll(): string {
    const wts = this._loadIndex().worktrees;
    if (!wts.length) return "No worktrees in index.";
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id != null ? ` task=${wt.task_id}` : "";
      lines.push(
        `[${String(wt.status ?? "?")}] ${wt.name} -> ${wt.path} (${String(wt.branch ?? "-")})${suffix}`,
      );
    }
    return lines.join("\n");
  }

  status(name: string): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const p = String(wt.path);
    if (!fs.existsSync(p)) return `Error: Worktree path missing: ${p}`;
    const r = spawnSync("git", ["status", "--short", "--branch"], {
      cwd: p,
      encoding: "utf8",
      timeout: 60_000,
    });
    return String(r.stdout + r.stderr).trim() || "Clean worktree";
  }

  enter(name: string): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const p = String(wt.path);
    if (!fs.existsSync(p)) return `Error: Worktree path missing: ${p}`;
    const updated = this._updateEntry(name, { last_entered_at: Date.now() / 1000 });
    this.events.emit("worktree.enter", { task_id: wt.task_id, wt_name: name, path: p });
    return JSON.stringify(updated, null, 2);
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const p = String(wt.path);
    if (!fs.existsSync(p)) return `Error: Worktree path missing: ${p}`;
    try {
      this._updateEntry(name, {
        last_entered_at: Date.now() / 1000,
        last_command_at: Date.now() / 1000,
        last_command_preview: command.slice(0, 120),
      });
      this.events.emit("worktree.run.before", {
        task_id: wt.task_id,
        wt_name: name,
        command: command.slice(0, 120),
      });
      const r = spawnSync(command, { shell: "/bin/sh", cwd: p, encoding: "utf8", timeout: 300_000 });
      const out = String(r.stdout + r.stderr).trim();
      this.events.emit("worktree.run.after", { task_id: wt.task_id, wt_name: name });
      return out ? out.slice(0, 50_000) : "(no output)";
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const msg = String(err?.message ?? e);
      if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) {
        this.events.emit("worktree.run.timeout", { task_id: wt.task_id, wt_name: name });
        return "Error: Timeout (300s)";
      }
      return `Error: ${msg}`;
    }
  }

  remove(name: string, force = false, completeTask = false, reason = ""): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const taskId = wt.task_id as number | undefined;
    this.events.emit("worktree.remove.before", { task_id: taskId, wt_name: name });
    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(String(wt.path));
      this._runGit(args);
      if (completeTask && taskId != null) {
        this.tasks.update(taskId, "completed");
        this.events.emit("task.completed", { task_id: taskId, wt_name: name });
      }
      if (taskId != null) this.tasks.recordCloseout(taskId, "removed", reason, false);
      this._updateEntry(name, {
        status: "removed",
        removed_at: Date.now() / 1000,
        closeout: { action: "remove", reason, at: Date.now() / 1000 },
      });
      this.events.emit("worktree.remove.after", { task_id: taskId, wt_name: name });
      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.emit("worktree.remove.failed", { task_id: taskId, wt_name: name, error: String(e) });
      throw e;
    }
  }

  keep(name: string): string {
    const wt = this._find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const taskId = wt.task_id as number | undefined;
    if (taskId != null) this.tasks.recordCloseout(taskId, "kept", "", true);
    this._updateEntry(name, {
      status: "kept",
      kept_at: Date.now() / 1000,
      closeout: { action: "keep", reason: "", at: Date.now() / 1000 },
    });
    this.events.emit("worktree.keep", { task_id: taskId, wt_name: name });
    return JSON.stringify(this._find(name), null, 2);
  }

  closeout(name: string, action: string, reason = "", force = false, completeTask = false): string {
    if (action === "keep") {
      const wt = this._find(name);
      if (!wt) return `Error: Unknown worktree '${name}'`;
      const taskId = wt.task_id as number | undefined;
      if (taskId != null) {
        this.tasks.recordCloseout(taskId, "kept", reason, true);
        if (completeTask) this.tasks.update(taskId, "completed");
      }
      this._updateEntry(name, {
        status: "kept",
        kept_at: Date.now() / 1000,
        closeout: { action: "keep", reason, at: Date.now() / 1000 },
      });
      this.events.emit("worktree.closeout.keep", { task_id: taskId, wt_name: name, reason });
      return JSON.stringify(this._find(name), null, 2);
    }
    if (action === "remove") {
      this.events.emit("worktree.closeout.remove", { wt_name: name, reason });
      return this.remove(name, force, completeTask, reason);
    }
    throw new Error("action must be 'keep' or 'remove'");
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
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
    const s = String(out).trim();
    return s ? s.slice(0, 50_000) : "(no output)";
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const msg = String(err?.message ?? e);
    if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) return "Error: Timeout (120s)";
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
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
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
  task_list: () => TASKS.listAll(),
  task_get: (kw) => TASKS.get(Number(kw.task_id)),
  task_update: (kw) => TASKS.update(Number(kw.task_id), kw.status as string | undefined, kw.owner as string | undefined),
  task_bind_worktree: (kw) => TASKS.bindWorktree(Number(kw.task_id), String(kw.worktree), String(kw.owner ?? "")),
  worktree_create: (kw) => WORKTREES.create(String(kw.name), kw.task_id as number | undefined, String(kw.base_ref ?? "HEAD")),
  worktree_list: () => WORKTREES.listAll(),
  worktree_enter: (kw) => WORKTREES.enter(String(kw.name)),
  worktree_status: (kw) => WORKTREES.status(String(kw.name)),
  worktree_run: (kw) => WORKTREES.run(String(kw.name), String(kw.command)),
  worktree_closeout: (kw) =>
    WORKTREES.closeout(
      String(kw.name),
      String(kw.action),
      String(kw.reason ?? ""),
      Boolean(kw.force ?? false),
      Boolean(kw.complete_task ?? false),
    ),
  worktree_keep: (kw) => WORKTREES.keep(String(kw.name)),
  worktree_remove: (kw) =>
    WORKTREES.remove(
      String(kw.name),
      Boolean(kw.force ?? false),
      Boolean(kw.complete_task ?? false),
      String(kw.reason ?? ""),
    ),
  worktree_events: (kw) => EVENTS.listRecent(kw.limit as number | undefined),
};

const TOOLS: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace.",
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
    description: "Create a new task on the shared task board.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "task_update",
    description: "Update task status or owner.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        owner: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree name.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        worktree: { type: "string" },
        owner: { type: "string" },
      },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "worktree_create",
    description: "Create a git worktree and optionally bind it to a task.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } },
      required: ["name"],
    },
  },
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.", input_schema: { type: "object", properties: {} } },
  {
    name: "worktree_enter",
    description: "Enter or reopen a worktree lane before working in it.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "worktree_status",
    description: "Show git status for one worktree.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "worktree_run",
    description: "Run a shell command in a named worktree directory.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, command: { type: "string" } },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_closeout",
    description: "Close out a lane by keeping it for follow-up or removing it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        action: { type: "string", enum: ["keep", "remove"] },
        reason: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },
      },
      required: ["name", "action"],
    },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean" },
        complete_task: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept without removing it.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "worktree_events",
    description: "List recent lifecycle events.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
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
  console.log(`Repo root for s18: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) console.log("Note: Not in a git repo. worktree_* tools will return errors.");

  const history: MessageParam[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms18 >> \x1b[0m");
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
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
