#!/usr/bin/env npx tsx
// Harness: safety -- the pipeline between intent and execution.
/**
 * s07_permission_system.ts - Permission System
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

const MODES = ["default", "plan", "auto"] as const;
type Mode = (typeof MODES)[number];

const READ_ONLY_TOOLS = new Set(["read_file", "bash_readonly"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

function fnmatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + pattern.split("*").map(esc).join(".*") + "$");
  return re.test(value);
}

class BashSecurityValidator {
  static VALIDATORS: Array<[string, RegExp]> = [
    ["shell_metachar", /[;&|`$]/],
    ["sudo", /\bsudo\b/],
    ["rm_rf", /\brm\s+(-[a-zA-Z]*)?r/],
    ["cmd_substitution", /\$\(/],
    ["ifs_injection", /\bIFS\s*=/],
  ];

  validate(command: string): Array<[string, RegExp]> {
    const failures: Array<[string, RegExp]> = [];
    for (const [name, pattern] of BashSecurityValidator.VALIDATORS) {
      if (pattern.test(command)) failures.push([name, pattern]);
    }
    return failures;
  }

  isSafe(command: string): boolean {
    return this.validate(command).length === 0;
  }

  describeFailures(command: string): string {
    const failures = this.validate(command);
    if (!failures.length) return "No issues detected";
    const parts = failures.map(([name, pat]) => `${name} (pattern: ${pat.source})`);
    return "Security flags: " + parts.join(", ");
  }
}

const bashValidator = new BashSecurityValidator();

function isWorkspaceTrusted(workspace = WORKDIR): boolean {
  const trustMarker = path.join(workspace, ".claude", ".claude_trusted");
  return fs.existsSync(trustMarker);
}

type Rule = Record<string, string> & { behavior: "allow" | "deny" | "ask" };

const DEFAULT_RULES: Rule[] = [
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  { tool: "read_file", path: "*", behavior: "allow" },
];

class PermissionManager {
  mode: Mode;
  rules: Rule[];
  consecutiveDenials = 0;
  maxConsecutiveDenials = 3;

  constructor(mode: string = "default", rules?: Rule[]) {
    if (!MODES.includes(mode as Mode)) {
      throw new Error(`Unknown mode: ${mode}. Choose from ${MODES.join(", ")}`);
    }
    this.mode = mode as Mode;
    this.rules = rules ?? [...DEFAULT_RULES];
  }

  check(toolName: string, toolInput: Record<string, unknown>): { behavior: "allow" | "deny" | "ask"; reason: string } {
    if (toolName === "bash") {
      const command = String(toolInput.command ?? "");
      const failures = bashValidator.validate(command);
      if (failures.length) {
        const severe = new Set(["sudo", "rm_rf"]);
        const severeHits = failures.filter((f) => severe.has(f[0]));
        if (severeHits.length) {
          const desc = bashValidator.describeFailures(command);
          return { behavior: "deny", reason: `Bash validator: ${desc}` };
        }
        const desc = bashValidator.describeFailures(command);
        return { behavior: "ask", reason: `Bash validator flagged: ${desc}` };
      }
    }

    for (const rule of this.rules) {
      if (rule.behavior !== "deny") continue;
      if (this._matches(rule, toolName, toolInput)) {
        return { behavior: "deny", reason: `Blocked by deny rule: ${JSON.stringify(rule)}` };
      }
    }

    if (this.mode === "plan") {
      if (WRITE_TOOLS.has(toolName)) {
        return { behavior: "deny", reason: "Plan mode: write operations are blocked" };
      }
      return { behavior: "allow", reason: "Plan mode: read-only allowed" };
    }

    if (this.mode === "auto") {
      if (READ_ONLY_TOOLS.has(toolName) || toolName === "read_file") {
        return { behavior: "allow", reason: "Auto mode: read-only tool auto-approved" };
      }
    }

    for (const rule of this.rules) {
      if (rule.behavior !== "allow") continue;
      if (this._matches(rule, toolName, toolInput)) {
        this.consecutiveDenials = 0;
        return { behavior: "allow", reason: `Matched allow rule: ${JSON.stringify(rule)}` };
      }
    }

    return { behavior: "ask", reason: `No rule matched for ${toolName}, asking user` };
  }

  async askUser(toolName: string, toolInput: Record<string, unknown>, rl: readline.Interface): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200);
    console.log(`\n  [Permission] ${toolName}: ${preview}`);
    let answer: string;
    try {
      answer = (await rl.question("  Allow? (y/n/always): ")).trim().toLowerCase();
    } catch {
      return false;
    }

    if (answer === "always") {
      this.rules.push({ tool: toolName, path: "*", behavior: "allow" });
      this.consecutiveDenials = 0;
      return true;
    }
    if (answer === "y" || answer === "yes") {
      this.consecutiveDenials = 0;
      return true;
    }

    this.consecutiveDenials += 1;
    if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
      console.log(
        `  [${this.consecutiveDenials} consecutive denials -- consider switching to plan mode]`,
      );
    }
    return false;
  }

  private _matches(rule: Rule, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (rule.tool && rule.tool !== "*") {
      if (rule.tool !== toolName) return false;
    }
    if (rule.path && rule.path !== "*") {
      const p = String(toolInput.path ?? "");
      if (!fnmatch(rule.path, p)) return false;
    }
    if (rule.content) {
      const command = String(toolInput.command ?? "");
      if (!fnmatch(rule.content, command)) return false;
    }
    return true;
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
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.`;

async function agentLoop(messages: MessageParam[], perms: PermissionManager, rl: readline.Interface): Promise<void> {
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

      const decision = perms.check(block.name, (block.input ?? {}) as Record<string, unknown>);
      let output: string;

      if (decision.behavior === "deny") {
        output = `Permission denied: ${decision.reason}`;
        console.log(`  [DENIED] ${block.name}: ${decision.reason}`);
      } else if (decision.behavior === "ask") {
        if (await perms.askUser(block.name, (block.input ?? {}) as Record<string, unknown>, rl)) {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler((block.input ?? {}) as Record<string, unknown>) : `Unknown: ${block.name}`;
          console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        } else {
          output = `Permission denied by user for ${block.name}`;
          console.log(`  [USER DENIED] ${block.name}`);
        }
      } else {
        const handler = TOOL_HANDLERS[block.name];
        output = handler ? handler((block.input ?? {}) as Record<string, unknown>) : `Unknown: ${block.name}`;
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("Permission modes: default, plan, auto");
  const rl = readline.createInterface({ input, output });
  try {
    let modeInput = (await rl.question("Mode (default): ")).trim().toLowerCase() || "default";
    if (!MODES.includes(modeInput as Mode)) modeInput = "default";

    const perms = new PermissionManager(modeInput);
    console.log(`[Permission mode: ${modeInput}]`);

    const history: MessageParam[] = [];
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms07 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      if (query.startsWith("/mode")) {
        const parts = query.split(/\s+/);
        if (parts.length === 2 && MODES.includes(parts[1] as Mode)) {
          perms.mode = parts[1] as Mode;
          console.log(`[Switched to ${parts[1]} mode]`);
        } else {
          console.log(`Usage: /mode <${MODES.join("|")}>`);
        }
        continue;
      }

      if (query.trim() === "/rules") {
        perms.rules.forEach((rule, i) => console.log(`  ${i}: ${JSON.stringify(rule)}`));
        continue;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history, perms, rl);
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
