#!/usr/bin/env npx tsx
// Harness: persistence -- remembering across the session boundary.
/**
 * s09_memory_system.ts - Memory System
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

const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
const MAX_INDEX_LINES = 200;

type MemoryType = (typeof MEMORY_TYPES)[number];

class MemoryManager {
  memoryDir: string;
  memories = new Map<
    string,
    { description: string; type: MemoryType | string; content: string; file: string }
  >();

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir ?? MEMORY_DIR;
  }

  loadAll(): void {
    this.memories.clear();
    if (!fs.existsSync(this.memoryDir)) return;

    for (const mdFile of fs
      .readdirSync(this.memoryDir)
      .filter((n) => n.endsWith(".md") && n !== "MEMORY.md")
      .sort()
      .map((n) => path.join(this.memoryDir, n))) {
      const parsed = this._parseFrontmatter(fs.readFileSync(mdFile, "utf8"));
      if (!parsed) continue;
      const name = parsed.name ?? path.basename(mdFile, ".md");
      this.memories.set(name, {
        description: parsed.description ?? "",
        type: parsed.type ?? "project",
        content: parsed.content ?? "",
        file: path.basename(mdFile),
      });
    }

    const count = this.memories.size;
    if (count > 0) {
      console.log(`[Memory loaded: ${count} memories from ${this.memoryDir}]`);
    }
  }

  loadMemoryPrompt(): string {
    if (!this.memories.size) return "";

    const sections: string[] = ["# Memories (persistent across sessions)", ""];
    for (const memType of MEMORY_TYPES) {
      const typed = [...this.memories.entries()].filter(([, v]) => v.type === memType);
      if (!typed.length) continue;
      sections.push(`## [${memType}]`);
      for (const [name, mem] of typed) {
        sections.push(`### ${name}: ${mem.description}`);
        if (mem.content.trim()) sections.push(mem.content.trim());
        sections.push("");
      }
    }
    return sections.join("\n");
  }

  saveMemory(name: string, description: string, memType: string, content: string): string {
    if (!MEMORY_TYPES.includes(memType as MemoryType)) {
      return `Error: type must be one of ${MEMORY_TYPES.join(", ")}`;
    }

    const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!safeName) return "Error: invalid memory name";

    fs.mkdirSync(this.memoryDir, { recursive: true });

    const frontmatter =
      "---\n" +
      `name: ${name}\n` +
      `description: ${description}\n` +
      `type: ${memType}\n` +
      "---\n" +
      `${content}\n`;
    const fileName = `${safeName}.md`;
    const filePath = path.join(this.memoryDir, fileName);
    fs.writeFileSync(filePath, frontmatter, "utf8");

    this.memories.set(name, {
      description,
      type: memType,
      content,
      file: fileName,
    });

    this._rebuildIndex();

    return `Saved memory '${name}' [${memType}] to ${path.relative(WORKDIR, filePath)}`;
  }

  private _rebuildIndex(): void {
    const lines: string[] = ["# Memory Index", ""];
    for (const [name, mem] of this.memories.entries()) {
      lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
        break;
      }
    }
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.writeFileSync(MEMORY_INDEX, lines.join("\n") + "\n", "utf8");
  }

  private _parseFrontmatter(text: string): Record<string, string> | null {
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/.exec(text);
    if (!match) return null;
    const header = match[1]!;
    const body = match[2]!.trim();
    const result: Record<string, string> = { content: body };
    for (const line of header.split(/\r?\n/)) {
      if (!line.includes(":")) continue;
      const idx = line.indexOf(":");
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return result;
  }
}

class DreamConsolidator {
  static COOLDOWN_SECONDS = 86_400;
  static SCAN_THROTTLE_SECONDS = 600;
  static MIN_SESSION_COUNT = 5;
  static LOCK_STALE_SECONDS = 3600;

  static PHASES = [
    "Orient: scan MEMORY.md index for structure and categories",
    "Gather: read individual memory files for full content",
    "Consolidate: merge related memories, remove stale entries",
    "Prune: enforce 200-line limit on MEMORY.md index",
  ] as const;

  memoryDir: string;
  lockFile: string;
  enabled = true;
  mode = "default";
  lastConsolidationTime = 0;
  lastScanTime = 0;
  sessionCount = 0;

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir ?? MEMORY_DIR;
    this.lockFile = path.join(this.memoryDir, ".dream_lock");
  }

  shouldConsolidate(): [boolean, string] {
    const now = Date.now() / 1000;

    if (!this.enabled) return [false, "Gate 1: consolidation is disabled"];
    if (!fs.existsSync(this.memoryDir)) return [false, "Gate 2: memory directory does not exist"];

    let memoryFiles = fs.readdirSync(this.memoryDir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
    if (!memoryFiles.length) return [false, "Gate 2: no memory files found"];

    if (this.mode === "plan") return [false, "Gate 3: plan mode does not allow consolidation"];

    const timeSinceLast = now - this.lastConsolidationTime;
    if (timeSinceLast < DreamConsolidator.COOLDOWN_SECONDS) {
      const remaining = Math.floor(DreamConsolidator.COOLDOWN_SECONDS - timeSinceLast);
      return [false, `Gate 4: cooldown active, ${remaining}s remaining`];
    }

    const timeSinceScan = now - this.lastScanTime;
    if (timeSinceScan < DreamConsolidator.SCAN_THROTTLE_SECONDS) {
      const remaining = Math.floor(DreamConsolidator.SCAN_THROTTLE_SECONDS - timeSinceScan);
      return [false, `Gate 5: scan throttle active, ${remaining}s remaining`];
    }

    if (this.sessionCount < DreamConsolidator.MIN_SESSION_COUNT) {
      return [false, `Gate 6: only ${this.sessionCount} sessions, need ${DreamConsolidator.MIN_SESSION_COUNT}`];
    }

    if (!this._acquireLock()) return [false, "Gate 7: lock held by another process"];

    return [true, "All 7 gates passed"];
  }

  consolidate(): string[] {
    const [canRun, reason] = this.shouldConsolidate();
    if (!canRun) {
      console.log(`[Dream] Cannot consolidate: ${reason}`);
      return [];
    }

    console.log("[Dream] Starting consolidation...");
    this.lastScanTime = Date.now() / 1000;

    const completedPhases: string[] = [];
    DreamConsolidator.PHASES.forEach((phase, i) => {
      console.log(`[Dream] Phase ${i + 1}/4: ${phase}`);
      completedPhases.push(phase);
    });

    this.lastConsolidationTime = Date.now() / 1000;
    this._releaseLock();
    console.log(`[Dream] Consolidation complete: ${completedPhases.length} phases executed`);
    return [...completedPhases];
  }

  private _acquireLock(): boolean {
    if (fs.existsSync(this.lockFile)) {
      try {
        const lockData = fs.readFileSync(this.lockFile, "utf8").trim();
        const [pidStr, timestampStr] = lockData.split(":");
        const pid = Number(pidStr);
        const lockTime = Number(timestampStr);

        if (Date.now() / 1000 - lockTime > DreamConsolidator.LOCK_STALE_SECONDS) {
          console.log(`[Dream] Removing stale lock from PID ${pid}`);
          fs.unlinkSync(this.lockFile);
        } else {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            console.log(`[Dream] Removing lock from dead PID ${pid}`);
            fs.unlinkSync(this.lockFile);
          }
        }
      } catch {
        try {
          fs.unlinkSync(this.lockFile);
        } catch {
          /* ignore */
        }
      }
    }

    try {
      fs.mkdirSync(this.memoryDir, { recursive: true });
      fs.writeFileSync(this.lockFile, `${process.pid}:${Date.now() / 1000}`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private _releaseLock(): void {
    try {
      if (!fs.existsSync(this.lockFile)) return;
      const lockData = fs.readFileSync(this.lockFile, "utf8").trim();
      const pidStr = lockData.split(":")[0]!;
      if (Number(pidStr) === process.pid) {
        fs.unlinkSync(this.lockFile);
      }
    } catch {
      /* ignore */
    }
  }
}

const memoryMgr = new MemoryManager();

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

function runSaveMemory(name: string, description: string, memType: string, content: string): string {
  return memoryMgr.saveMemory(name, description, memType, content);
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => runBash(String(kw.command)),
  read_file: (kw) => runRead(String(kw.path), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  save_memory: (kw) => runSaveMemory(String(kw.name), String(kw.description), String(kw.type), String(kw.content)),
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
    name: "save_memory",
    description: "Save a persistent memory that survives across sessions.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short identifier (e.g. prefer_tabs, db_schema)" },
        description: {
          type: "string",
          description: "One-line summary of what this memory captures",
        },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description:
            "user=preferences, feedback=corrections, project=non-obvious project conventions or decision reasons, reference=external resource pointers",
        },
        content: { type: "string", description: "Full memory content (multi-line OK)" },
      },
      required: ["name", "description", "type", "content"],
    },
  },
];

const MEMORY_GUIDANCE = `
When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)
`;

function buildSystemPrompt(): string {
  const parts = [`You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`];
  const memorySection = memoryMgr.loadMemoryPrompt();
  if (memorySection) parts.push(memorySection);
  parts.push(MEMORY_GUIDANCE);
  return parts.join("\n\n");
}

async function agentLoop(messages: MessageParam[]): Promise<void> {
  while (true) {
    const system = buildSystemPrompt();
    const response = await client.messages.create({
      model: MODEL,
      system,
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
        output = handler
          ? handler((block.input ?? {}) as Record<string, unknown>)
          : `Unknown: ${block.name}`;
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
  memoryMgr.loadAll();
  const memCount = memoryMgr.memories.size;
  if (memCount) {
    console.log(`[${memCount} memories loaded into context]`);
  } else {
    console.log("[No existing memories. The agent can create them with save_memory.]");
  }

  const history: MessageParam[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms09 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      if (query.trim() === "/memories") {
        if (memoryMgr.memories.size) {
          for (const [name, mem] of memoryMgr.memories.entries()) {
            console.log(`  [${mem.type}] ${name}: ${mem.description}`);
          }
        } else {
          console.log("  (no memories)");
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
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main();
}
