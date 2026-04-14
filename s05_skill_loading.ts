#!/usr/bin/env npx tsx
// Harness: on-demand knowledge -- discover skills cheaply, load them only when needed.
/**
 * s05_skill_loading.ts - Skills
 *
 * This chapter teaches a two-layer skill model:
 *
 * 1. Put a cheap skill catalog in the system prompt.
 * 2. Load the full skill body only when the model asks for it.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID!;
const SKILLS_DIR = path.join(WORKDIR, "skills");

interface SkillManifest {
  name: string;
  description: string;
  path: string;
}

interface SkillDocument {
  manifest: SkillManifest;
  body: string;
}

function* walkFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

class SkillRegistry {
  skillsDir: string;
  documents = new Map<string, SkillDocument>();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this._loadAll();
  }

  private _loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) return;

    const paths = [...walkFiles(this.skillsDir)]
      .filter((p) => path.basename(p) === "SKILL.md")
      .sort();
    for (const filePath of paths) {
      const meta = this._parseFrontmatter(fs.readFileSync(filePath, "utf8"));
      const name = meta.name ?? path.basename(path.dirname(filePath));
      const description = meta.description ?? "No description";
      const manifest: SkillManifest = { name, description, path: filePath };
      this.documents.set(name, { manifest, body: meta.body });
    }
  }

  private _parseFrontmatter(text: string): { name?: string; description?: string; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)/.exec(text);
    if (!match) {
      return { body: text };
    }
    const meta: Record<string, string> = {};
    for (const line of match[1]!.trim().split(/\r?\n/)) {
      if (!line.includes(":")) continue;
      const idx = line.indexOf(":");
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return {
      name: meta.name,
      description: meta.description,
      body: match[2]!.trim(),
    };
  }

  describeAvailable(): string {
    if (!this.documents.size) return "(no skills available)";
    const lines: string[] = [];
    for (const name of [...this.documents.keys()].sort()) {
      const manifest = this.documents.get(name)!.manifest;
      lines.push(`- ${manifest.name}: ${manifest.description}`);
    }
    return lines.join("\n");
  }

  loadFullText(name: string): string {
    const document = this.documents.get(name);
    if (!document) {
      const known = [...this.documents.keys()].sort().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available skills: ${known}`;
    }
    return `<skill name="${document.manifest.name}">\n${document.body}\n</skill>`;
  }
}

const SKILL_REGISTRY = new SkillRegistry(SKILLS_DIR);

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill when a task needs specialized instructions before you act.

Skills available:
${SKILL_REGISTRY.describeAvailable()}
`;

function safePath(pathStr: string): string {
  const resolved = path.resolve(WORKDIR, pathStr);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
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
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (exc) {
    return `Error: ${exc}`;
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
  } catch (exc) {
    return `Error: ${exc}`;
  }
}

const TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => runBash(String(kw.command)),
  read_file: (kw) => runRead(String(kw.path), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
  load_skill: (kw) => SKILL_REGISTRY.loadFullText(String(kw.name)),
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
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
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
    name: "load_skill",
    description: "Load the full body of a named skill into the current context.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
]);

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as { text?: string }[]) {
    if (block?.text) texts.push(block.text);
  }
  return texts.join("\n").trim();
}

async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await callChatCompletion(messages, TOOLS, SYSTEM);

    // 将工具调用转换为消息
    if (Array.isArray(response.content)) {
      messages.push({ role: "assistant", content: JSON.stringify(response.content) });
    } else {
      messages.push({ role: "assistant", content: response.content });
    }

    if (!hasToolCalls(response)) return;

    const toolCalls = response.content as typeof response.content extends Array<infer T> ? T : never;
    const results: Message[] = [];

    for (const call of toolCalls as Array<{ id: string; function: { name: string; arguments: string } }>) {
      const handler = TOOL_HANDLERS[call.function.name];
      let out: string;
      try {
        out = handler ? handler(getToolCallArgs(call)) : `Unknown tool: ${call.function.name}`;
      } catch (exc) {
        out = `Error: ${exc}`;
      }

      console.log(`> ${call.function.name}: ${out.slice(0, 200)}`);
      results.push({ role: "tool", tool_call_id: call.id, content: out });
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
        query = await rl.question("\x1b[36ms05 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      history.push({ role: "user", content: query });
      await agentLoop(history);

      const last = history[history.length - 1];
      const finalText = extractText(last?.content);
      if (finalText) console.log(finalText);
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
