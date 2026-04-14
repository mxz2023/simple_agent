#!/usr/bin/env npx tsx
// Harness: autonomy -- models that find work without being told.
/**
 * s17_autonomous_agents.ts - Autonomous Agents
 *
 * Idle polling, auto-claim of unclaimed tasks, identity re-injection after compression.
 */

import * as crypto from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const REQUESTS_DIR = path.join(TEAM_DIR, "requests");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const CLAIM_EVENTS_PATH = path.join(TASKS_DIR, "claim_events.jsonl");

const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval",
  "plan_approval_response",
]);

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

class MessageBus {
  constructor(private readonly inboxDir: string) {
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg: Record<string, unknown> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    const inboxPath = path.join(this.inboxDir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): unknown[] {
    const inboxPath = path.join(this.inboxDir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const raw = fs.readFileSync(inboxPath, "utf8").trim();
    const messages = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    fs.writeFileSync(inboxPath, "", "utf8");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

class RequestStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private _path(requestId: string): string {
    return path.join(this.dir, `${requestId}.json`);
  }

  create(record: Record<string, unknown>): Record<string, unknown> {
    const requestId = String(record.request_id);
    fs.writeFileSync(this._path(requestId), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  get(requestId: string): Record<string, unknown> | null {
    const p = this._path(requestId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  }

  update(requestId: string, changes: Record<string, unknown>): Record<string, unknown> | null {
    const record = this.get(requestId);
    if (!record) return null;
    Object.assign(record, changes);
    record.updated_at = Date.now() / 1000;
    fs.writeFileSync(this._path(requestId), JSON.stringify(record, null, 2), "utf8");
    return record;
  }
}

const REQUEST_STORE = new RequestStore(REQUESTS_DIR);

function appendClaimEvent(payload: Record<string, unknown>): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.appendFileSync(CLAIM_EVENTS_PATH, JSON.stringify(payload) + "\n", "utf8");
}

function taskAllowsRole(task: Record<string, unknown>, role: string | null | undefined): boolean {
  const requiredRole = String(task.claim_role ?? task.required_role ?? "");
  if (!requiredRole) return true;
  return Boolean(role) && role === requiredRole;
}

function isClaimableTask(task: Record<string, unknown>, role?: string | null): boolean {
  const owner = task.owner;
  const blockedBy = task.blockedBy;
  const hasOwner = owner != null && owner !== "";
  const hasBlocked = Array.isArray(blockedBy) ? blockedBy.length > 0 : Boolean(blockedBy);
  return task.status === "pending" && !hasOwner && !hasBlocked && taskAllowsRole(task, role);
}

function scanUnclaimedTasks(role?: string | null): Record<string, unknown>[] {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: Record<string, unknown>[] = [];
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
  for (const f of files) {
    const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Record<string, unknown>;
    if (isClaimableTask(task, role)) unclaimed.push(task);
  }
  return unclaimed;
}

function claimTask(taskId: number, owner: string, role?: string | null, source = "manual"): string {
  const p = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(p)) return `Error: Task ${taskId} not found`;
  const task = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  if (!isClaimableTask(task, role)) {
    return `Error: Task ${taskId} is not claimable for role=${role ?? "(any)"}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  task.claimed_at = Date.now() / 1000;
  task.claim_source = source;
  fs.writeFileSync(p, JSON.stringify(task, null, 2), "utf8");
  appendClaimEvent({
    event: "task.claimed",
    task_id: taskId,
    owner,
    role,
    source,
    ts: Date.now() / 1000,
  });
  return `Claimed task #${taskId} for ${owner} via ${source}`;
}

function makeIdentityBlock(name: string, role: string, teamName: string): Message {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

function ensureIdentityContext(messages: Message[], name: string, role: string, teamName: string): void {
  if (messages.length && String((messages[0] as { content?: unknown }).content ?? "").includes("<identity>")) {
    return;
  }
  messages.splice(0, 0, makeIdentityBlock(name, role, teamName));
  messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
}

interface Member {
  name: string;
  role: string;
  status: string;
}

interface TeamConfig {
  team_name: string;
  members: Member[];
}

class TeammateManager {
  dir: string;
  configPath: string;
  config: TeamConfig;

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this._loadConfig();
  }

  private _loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8")) as TeamConfig;
    }
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  private _findMember(name: string): Member | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private _setStatus(name: string, status: string): void {
    const member = this._findMember(name);
    if (member) {
      member.status = status;
      this._saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
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
    this._saveConfig();
    void this._loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private async _loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: Message[] = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();

    while (true) {
      for (let i = 0; i < 50; i++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox as Record<string, unknown>[]) {
          if (msg.type === "shutdown_request") {
            this._setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response;
        try {
          response = await callChatCompletion(messages, tools, sysPrompt);
        } catch {
          this._setStatus(name, "idle");
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
            output = "Entering idle phase. Will poll for new tasks.";
          } else {
            output = this._exec(name, toolName, getToolCallArgs(call));
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
        await sleepSeconds(POLL_INTERVAL);
        const inbox = BUS.readInbox(name);
        if (inbox.length) {
          ensureIdentityContext(messages, name, role, teamName);
          for (const msg of inbox as Record<string, unknown>[]) {
            if (msg.type === "shutdown_request") {
              this._setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }
        const unclaimed = scanUnclaimedTasks(role);
        if (unclaimed.length) {
          const task = unclaimed[0]!;
          const tid = Number(task.id);
          const claimResult = claimTask(tid, name, role, "auto");
          if (claimResult.startsWith("Error:")) continue;
          const taskPrompt =
            `<auto-claimed>Task #${task.id}: ${task.subject}\n` + `${String(task.description ?? "")}</auto-claimed>`;
          ensureIdentityContext(messages, name, role, teamName);
          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `${claimResult}. Working on it.` });
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

  private _exec(sender: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "bash") return _runBash(String(args.command));
    if (toolName === "read_file") return _runRead(String(args.path));
    if (toolName === "write_file") return _runWrite(String(args.path), String(args.content));
    if (toolName === "edit_file") {
      return _runEdit(String(args.path), String(args.old_text), String(args.new_text));
    }
    if (toolName === "send_message") {
      const msgType = String((args as { msg_type?: string }).msg_type ?? "message");
      return BUS.send(sender, String(args.to), String(args.content), msgType);
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    if (toolName === "shutdown_response") {
      const reqId = String(args.request_id);
      const updated = REQUEST_STORE.update(reqId, {
        status: args.approve ? "approved" : "rejected",
        resolved_by: sender,
        resolved_at: Date.now() / 1000,
        response: { approve: args.approve, reason: String(args.reason ?? "") },
      });
      if (!updated) return `Error: Unknown shutdown request ${reqId}`;
      BUS.send(sender, "lead", String(args.reason ?? ""), "shutdown_response", {
        request_id: reqId,
        approve: Boolean(args.approve),
      });
      return `Shutdown ${args.approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = String(args.plan ?? "");
      const reqId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      REQUEST_STORE.create({
        request_id: reqId,
        kind: "plan_approval",
        from: sender,
        to: "lead",
        status: "pending",
        plan: planText,
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
      });
      BUS.send(sender, "lead", planText, "plan_approval", { request_id: reqId, plan: planText });
      return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
    }
    if (toolName === "claim_task") {
      const m = this._findMember(sender);
      return claimTask(Number(args.task_id), sender, m?.role, "manual");
    }
    return `Unknown tool: ${toolName}`;
  }

  private _teammateTools(): Tool[] {
    return convertTools([
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
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
        name: "send_message",
        description: "Send message to a teammate.",
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
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
      },
      {
        name: "idle",
        description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim a task from the task board by ID.",
        input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
      },
    ]);
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

const TEAM = new TeammateManager(TEAM_DIR);

function _safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function _runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
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

function _runRead(filePath: string, limit?: number | null): string {
  try {
    let lines = fs.readFileSync(_safePath(filePath), "utf8").split(/\r?\n/);
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function _runWrite(filePath: string, content: string): string {
  try {
    const fp = _safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function _runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = _safePath(filePath);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function handleShutdownRequest(teammate: string): string {
  const reqId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  REQUEST_STORE.create({
    request_id: reqId,
    kind: "shutdown",
    from: "lead",
    to: teammate,
    status: "pending",
    created_at: Date.now() / 1000,
    updated_at: Date.now() / 1000,
  });
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = REQUEST_STORE.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  REQUEST_STORE.update(requestId, {
    status: approve ? "approved" : "rejected",
    reviewed_by: "lead",
    resolved_at: Date.now() / 1000,
    feedback,
  });
  const from = String(req.from ?? "");
  BUS.send("lead", from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${approve ? "approved" : "rejected"} for '${from}'`;
}

function _checkShutdownStatus(requestId: string): string {
  return JSON.stringify(REQUEST_STORE.get(requestId) ?? { error: "not found" }, null, 2);
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => _runBash(String(kw.command)),
  read_file: (kw) => _runRead(String(kw.path), kw.limit as number | undefined),
  write_file: (kw) => _runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => _runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  spawn_teammate: (kw) => TEAM.spawn(String(kw.name), String(kw.role), String(kw.prompt)),
  list_teammates: () => TEAM.listAll(),
  send_message: (kw) => BUS.send("lead", String(kw.to), String(kw.content), String(kw.msg_type ?? "message")),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (kw) => BUS.broadcast("lead", String(kw.content), TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(String(kw.teammate)),
  shutdown_response: (kw) => _checkShutdownStatus(String(kw.request_id ?? "")),
  plan_approval: (kw) => handlePlanReview(String(kw.request_id), Boolean(kw.approve), String(kw.feedback ?? "")),
  idle: () => "Lead does not idle.",
  claim_task: (kw) => claimTask(Number(kw.task_id), "lead"),
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
    name: "spawn_teammate",
    description: "Spawn an autonomous teammate.",
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
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
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
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "shutdown_response",
    description: "Check shutdown request status.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
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
  {
    name: "idle",
    description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
]);

async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
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

    for (const call of toolCalls) {
      const handler = TOOL_HANDLERS[call.function.name];
      let output: string;
      try {
        output = handler ? handler(getToolCallArgs(call)) : `Unknown tool: ${call.function.name}`;
      } catch (e) {
        output = `Error: ${e}`;
      }
      console.log(`> ${call.function.name}: ${String(output).slice(0, 200)}`);
      results.push({ role: "tool", tool_call_id: call.id, content: String(output) });
    }
    messages.push(...results);
  }
}

async function main(): Promise<void> {
  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms17 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }
      if (query.trim() === "/tasks") {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
        for (const f of files) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Record<string, unknown>;
          const marker =
            t.status === "pending" ? "[ ]" : t.status === "in_progress" ? "[>]" : t.status === "completed" ? "[x]" : "[?]";
          const owner = t.owner ? ` @${t.owner}` : "";
          console.log(`  ${marker} #${t.id}: ${t.subject}${owner}`);
        }
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
    rl.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
