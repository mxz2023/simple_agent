#!/usr/bin/env npx tsx
// Harness: assembly -- the system prompt is a pipeline, not a string.
/**
 * s10_system_prompt.ts - System Prompt Construction
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID!;

const DYNAMIC_BOUNDARY = "=== DYNAMIC_BOUNDARY ===";

class SystemPromptBuilder {
  workdir: string;
  tools: Tool[];
  skillsDir: string;
  memoryDir: string;

  constructor(workdir?: string, tools?: Tool[]) {
    this.workdir = workdir ?? WORKDIR;
    this.tools = tools ?? [];
    this.skillsDir = path.join(this.workdir, "skills");
    this.memoryDir = path.join(this.workdir, ".memory");
  }

  private _buildCore(): string {
    return (
      `You are a coding agent operating in ${this.workdir}.\n` +
      "Use the provided tools to explore, read, write, and edit files.\n" +
      "Always verify before assuming. Prefer reading files over guessing."
    );
  }

  private _buildToolListing(): string {
    if (!this.tools.length) return "";
    const lines: string[] = ["# Available tools"];
    for (const tool of this.tools) {
      const props = (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      const params = Object.keys(props).join(", ");
      lines.push(`- ${tool.name}(${params}): ${tool.description ?? ""}`);
    }
    return lines.join("\n");
  }

  private _buildSkillListing(): string {
    if (!fs.existsSync(this.skillsDir)) return "";
    const skills: string[] = [];
    for (const name of fs.readdirSync(this.skillsDir).sort()) {
      const skillDir = path.join(this.skillsDir, name);
      if (!fs.statSync(skillDir).isDirectory()) continue;
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const text = fs.readFileSync(skillMd, "utf8");
      const match = /^---\s*\n([\s\S]*?)\n---/.exec(text);
      if (!match) continue;
      const meta: Record<string, string> = {};
      for (const line of match[1]!.split(/\r?\n/)) {
        if (!line.includes(":")) continue;
        const idx = line.indexOf(":");
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const skillName = meta.name ?? name;
      const desc = meta.description ?? "";
      skills.push(`- ${skillName}: ${desc}`);
    }
    if (!skills.length) return "";
    return "# Available skills\n" + skills.join("\n");
  }

  private _buildMemorySection(): string {
    if (!fs.existsSync(this.memoryDir)) return "";
    const memories: string[] = [];
    for (const mdFile of fs.readdirSync(this.memoryDir).sort()) {
      if (!mdFile.endsWith(".md") || mdFile === "MEMORY.md") continue;
      const text = fs.readFileSync(path.join(this.memoryDir, mdFile), "utf8");
      const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/.exec(text);
      if (!match) continue;
      const header = match[1]!;
      const body = match[2]!.trim();
      const meta: Record<string, string> = {};
      for (const line of header.split(/\r?\n/)) {
        if (!line.includes(":")) continue;
        const idx = line.indexOf(":");
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const name = meta.name ?? path.basename(mdFile, ".md");
      const memType = meta.type ?? "project";
      const desc = meta.description ?? "";
      memories.push(`[${memType}] ${name}: ${desc}\n${body}`);
    }
    if (!memories.length) return "";
    return "# Memories (persistent)\n\n" + memories.join("\n\n");
  }

  private _buildClaudeMd(): string {
    const sources: Array<[string, string]> = [];

    const userClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
    if (fs.existsSync(userClaude)) {
      sources.push(["user global (~/.claude/CLAUDE.md)", fs.readFileSync(userClaude, "utf8")]);
    }

    const projectClaude = path.join(this.workdir, "CLAUDE.md");
    if (fs.existsSync(projectClaude)) {
      sources.push(["project root (CLAUDE.md)", fs.readFileSync(projectClaude, "utf8")]);
    }

    const cwd = process.cwd();
    if (cwd !== this.workdir) {
      const subdirClaude = path.join(cwd, "CLAUDE.md");
      if (fs.existsSync(subdirClaude)) {
        sources.push([`subdir (${path.basename(cwd)}/CLAUDE.md)`, fs.readFileSync(subdirClaude, "utf8")]);
      }
    }

    if (!sources.length) return "";
    const parts = ["# CLAUDE.md instructions"];
    for (const [label, content] of sources) {
      parts.push(`## From ${label}`);
      parts.push(content.trim());
    }
    return parts.join("\n\n");
  }

  private _buildDynamicContext(): string {
    const lines = [
      `Current date: ${new Date().toISOString().slice(0, 10)}`,
      `Working directory: ${this.workdir}`,
      `Model: ${MODEL}`,
      `Platform: ${os.platform()}`,
    ];
    return "# Dynamic context\n" + lines.join("\n");
  }

  build(): string {
    const sections: string[] = [];

    const core = this._buildCore();
    if (core) sections.push(core);

    const tools = this._buildToolListing();
    if (tools) sections.push(tools);

    const skills = this._buildSkillListing();
    if (skills) sections.push(skills);

    const memory = this._buildMemorySection();
    if (memory) sections.push(memory);

    const claudeMd = this._buildClaudeMd();
    if (claudeMd) sections.push(claudeMd);

    sections.push(DYNAMIC_BOUNDARY);

    const dynamic = this._buildDynamicContext();
    if (dynamic) sections.push(dynamic);

    return sections.join("\n\n");
  }
}

function buildSystemReminder(extra?: string | null): Message | null {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  if (!parts.length) return null;
  const content = "<system-reminder>\n" + parts.join("\n") + "\n</system-reminder>";
  return { role: "user", content };
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

const promptBuilder = new SystemPromptBuilder(WORKDIR, TOOLS);

async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const system = promptBuilder.build();
    const response = await callChatCompletion(messages, TOOLS, system);

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
  const fullPrompt = promptBuilder.build();
  const sectionCount = (fullPrompt.match(/\n# /g) ?? []).length;
  console.log(`[System prompt assembled: ${fullPrompt.length} chars, ~${sectionCount} sections]`);

  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms10 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      if (query.trim() === "/prompt") {
        console.log("--- System Prompt ---");
        console.log(promptBuilder.build());
        console.log("--- End ---");
        continue;
      }

      if (query.trim() === "/sections") {
        const prompt = promptBuilder.build();
        for (const line of prompt.split(/\r?\n/)) {
          if (line.startsWith("# ") || line === DYNAMIC_BOUNDARY) {
            console.log(`  ${line}`);
          }
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
