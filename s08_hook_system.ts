#!/usr/bin/env npx tsx
// Harness: extensibility -- injecting behavior without touching the loop.
/**
 * s08_hook_system.ts - Hook System
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID!;

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
const HOOK_TIMEOUT = 30;
const TRUST_MARKER = path.join(WORKDIR, ".claude", ".claude_trusted");

type HookEvent = (typeof HOOK_EVENTS)[number];

class HookManager {
  hooks: Record<HookEvent, unknown[]> = {
    PreToolUse: [],
    PostToolUse: [],
    SessionStart: [],
  };
  private _sdkMode: boolean;
  private _configPath: string;

  constructor(configPath?: string, sdkMode = false) {
    this._sdkMode = sdkMode;
    this._configPath = configPath ?? path.join(WORKDIR, ".hooks.json");
    if (fs.existsSync(this._configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(this._configPath, "utf8")) as {
          hooks?: Partial<Record<HookEvent, unknown[]>>;
        };
        for (const event of HOOK_EVENTS) {
          this.hooks[event] = config.hooks?.[event] ?? [];
        }
        console.log(`[Hooks loaded from ${this._configPath}]`);
      } catch (e) {
        console.log(`[Hook config error: ${e}]`);
      }
    }
  }

  private _checkWorkspaceTrust(): boolean {
    if (this._sdkMode) return true;
    return fs.existsSync(TRUST_MARKER);
  }

  runHooks(
    event: HookEvent,
    context?: { tool_name?: string; tool_input?: Record<string, unknown>; tool_output?: string },
  ): {
    blocked: boolean;
    messages: string[];
    permission_override?: string;
    block_reason?: string;
  } {
    const result: {
      blocked: boolean;
      messages: string[];
      permission_override?: string;
      block_reason?: string;
    } = { blocked: false, messages: [] };

    if (!this._checkWorkspaceTrust()) return result;

    const hooks = (this.hooks[event] ?? []) as Array<Record<string, unknown>>;
    for (const hookDef of hooks) {
      const matcher = hookDef.matcher as string | undefined;
      if (matcher && context) {
        const toolName = context.tool_name ?? "";
        if (matcher !== "*" && matcher !== toolName) continue;
      }

      const command = String(hookDef.command ?? "");
      if (!command) continue;

      const env = { ...process.env } as NodeJS.ProcessEnv;
      if (context) {
        env.HOOK_EVENT = event;
        env.HOOK_TOOL_NAME = context.tool_name ?? "";
        env.HOOK_TOOL_INPUT = JSON.stringify(context.tool_input ?? {}).slice(0, 10_000);
        if (context.tool_output !== undefined) {
          env.HOOK_TOOL_OUTPUT = String(context.tool_output).slice(0, 10_000);
        }
      }

      try {
        const r = spawnSync(command, {
          shell: "/bin/sh",
          cwd: WORKDIR,
          env,
          encoding: "utf8",
          timeout: HOOK_TIMEOUT * 1000,
        });

        if (r.status === 0) {
          const stdout = String(r.stdout ?? "").trim();
          if (stdout) console.log(`  [hook:${event}] ${stdout.slice(0, 100)}`);

          try {
            const hookOutput = JSON.parse(stdout) as Record<string, unknown>;
            if (hookOutput.updatedInput && context) {
              context.tool_input = hookOutput.updatedInput as Record<string, unknown>;
            }
            if (typeof hookOutput.additionalContext === "string") {
              result.messages.push(hookOutput.additionalContext);
            }
            if (typeof hookOutput.permissionDecision === "string") {
              result.permission_override = hookOutput.permissionDecision;
            }
          } catch {
            /* stdout was not JSON */
          }
        } else if (r.status === 1) {
          result.blocked = true;
          const reason = String(r.stderr ?? "").trim() || "Blocked by hook";
          result.block_reason = reason;
          console.log(`  [hook:${event}] BLOCKED: ${reason.slice(0, 200)}`);
        } else if (r.status === 2) {
          const msg = String(r.stderr ?? "").trim();
          if (msg) {
            result.messages.push(msg);
            console.log(`  [hook:${event}] INJECT: ${msg.slice(0, 200)}`);
          }
        }
      } catch (e) {
        console.log(`  [hook:${event}] Error: ${e}`);
      }
    }

    return result;
  }
}

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
]);

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

async function agentLoop(messages: Message[], hooks: HookManager): Promise<void> {
  while (true) {
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
      const toolInput = { ...getToolCallArgs(call) };
      const ctx: {
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_output?: string;
      } = { tool_name: call.function.name, tool_input: toolInput };

      const preResult = hooks.runHooks("PreToolUse", ctx);

      for (const msg of preResult.messages) {
        results.push({
          role: "tool",
          tool_call_id: call.id,
          content: `[Hook message]: ${msg}`,
        });
      }

      if (preResult.blocked) {
        const reason = preResult.block_reason ?? "Blocked by hook";
        results.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Tool blocked by PreToolUse hook: ${reason}`,
        });
        continue;
      }

      const handler = TOOL_HANDLERS[call.function.name];
      let output: string;
      try {
        output = handler ? handler(ctx.tool_input) : `Unknown: ${call.function.name}`;
      } catch (e) {
        output = `Error: ${e}`;
      }
      console.log(`> ${call.function.name}: ${output.slice(0, 200)}`);

      ctx.tool_output = output;
      const postResult = hooks.runHooks("PostToolUse", ctx);
      for (const msg of postResult.messages) {
        output += `\n[Hook note]: ${msg}`;
      }

      results.push({ role: "tool", tool_call_id: call.id, content: String(output) });
    }

    messages.push(...results);
  }
}

async function main(): Promise<void> {
  const hooks = new HookManager();
  hooks.runHooks("SessionStart", { tool_name: "", tool_input: {} });

  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms08 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;
      history.push({ role: "user", content: query });
      await agentLoop(history, hooks);
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
