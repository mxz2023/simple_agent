#!/usr/bin/env npx tsx
// Harness: tool dispatch -- expanding what the model can reach.
/**
 * s02_tool_use.ts - Tool dispatch + message normalization
 *
 * The agent loop from s01 didn't change. We added tools to the dispatch map,
 * and a normalizeMessages() function that cleans up the message list before
 * each API call.
 *
 * Key insight: "The loop didn't change at all. I just added tools."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

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
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
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
    return `Wrote ${content.length} bytes to ${filePath}`;
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

const CONCURRENCY_SAFE = new Set(["read_file"]);
const CONCURRENCY_UNSAFE = new Set(["write_file", "edit_file"]);

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

type ContentBlockDict = Record<string, unknown>;

function normalizeMessages(messages: MessageParam[]): MessageParam[] {
  const cleaned: MessageParam[] = [];
  for (const msg of messages) {
    const clean = { role: msg.role } as MessageParam;
    const c = msg.content;
    if (typeof c === "string") {
      clean.content = c;
    } else if (Array.isArray(c)) {
      clean.content = c
        .filter((block) => typeof block === "object" && block !== null)
        .map((block) => {
          const o: ContentBlockDict = {};
          for (const [k, v] of Object.entries(block as unknown as Record<string, unknown>)) {
            if (!k.startsWith("_")) o[k] = v;
          }
          return o as unknown as Anthropic.Messages.ContentBlockParam;
        });
    } else {
      clean.content = (c as string | undefined) ?? "";
    }
    cleaned.push(clean);
  }

  const existingResults = new Set<string>();
  for (const msg of cleaned) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as unknown as ContentBlockDict;
        if (b.type === "tool_result") {
          existingResults.add(String(b.tool_use_id));
        }
      }
    }
  }

  for (const msg of cleaned) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as unknown as ContentBlockDict;
      if (b.type === "tool_use" && !existingResults.has(String(b.id))) {
        cleaned.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: String(b.id),
              content: "(cancelled)",
            },
          ],
        });
      }
    }
  }

  if (!cleaned.length) return cleaned;
  const merged: MessageParam[] = [cleaned[0]!];
  for (const msg of cleaned.slice(1)) {
    const prev = merged[merged.length - 1]!;
    if (msg.role === prev.role) {
      const prevC = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text" as const, text: String(prev.content) }];
      const currC = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text" as const, text: String(msg.content) }];
      prev.content = [...prevC, ...currC];
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

async function agentLoop(messages: MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: normalizeMessages(messages),
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name];
      const input = (block.input ?? {}) as Record<string, unknown>;
      const out = handler ? handler(input) : `Unknown tool: ${block.name}`;
      console.log(`> ${block.name}:`);
      console.log(out.slice(0, 200));
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
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
        query = await rl.question("\x1b[36ms02 >> \x1b[0m");
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
