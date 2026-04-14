#!/usr/bin/env npx tsx
// Harness: compression -- keep the active context small enough to keep working.
/**
 * s06_context_compact.ts - Context Compact
 *
 * This teaching version keeps the compact model intentionally small:
 *
 * 1. Large tool output is persisted to disk and replaced with a preview marker.
 * 2. Older tool results are micro-compacted into short placeholders.
 * 3. When the whole conversation gets too large, the agent summarizes it and
 *    continues from that summary.
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Keep working step by step, and use compact if the conversation gets too long.`;

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT_TOOL_RESULTS = 3;
const PERSIST_THRESHOLD = 30_000;
const PREVIEW_CHARS = 2000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

interface CompactState {
  hasCompacted: boolean;
  lastSummary: string;
  recentFiles: string[];
}

function jsonStringifySafe(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function estimateContextSize(messages: Message[]): number {
  return jsonStringifySafe(messages).length;
}

function trackRecentFile(state: CompactState, filePath: string): void {
  state.recentFiles = state.recentFiles.filter((p) => p !== filePath);
  state.recentFiles.push(filePath);
  if (state.recentFiles.length > 5) {
    state.recentFiles = state.recentFiles.slice(-5);
  }
}

function safePath(pathStr: string): string {
  const resolved = path.resolve(WORKDIR, pathStr);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${pathStr}`);
  }
  return resolved;
}

function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;

  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const storedPath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(storedPath)) {
    fs.writeFileSync(storedPath, output, "utf8");
  }

  const preview = output.slice(0, PREVIEW_CHARS);
  const relPath = path.relative(WORKDIR, storedPath);
  return (
    "<persisted-output>\n" +
    `Full output saved to: ${relPath}\n` +
    "Preview:\n" +
    `${preview}\n` +
    "</persisted-output>"
  );
}

function collectToolResultBlocks(messages: Message[]): Array<{ mi: number; bi: number; block: Record<string, unknown> }> {
  const blocks: Array<{ mi: number; bi: number; block: Record<string, unknown> }> = [];
  messages.forEach((message, messageIndex) => {
    const content = message.content;
    if (message.role !== "user" || !Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_result") {
        blocks.push({ mi: messageIndex, bi: blockIndex, block: block as unknown as Record<string, unknown> });
      }
    });
  });
  return blocks;
}

function microCompact(messages: Message[]): void {
  const toolResults = collectToolResultBlocks(messages);
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return;

  for (const { block } of toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    const content = block.content;
    if (typeof content !== "string" || content.length <= 120) continue;
    block.content =
      "[Earlier tool result compacted. Re-run the tool if you need full detail.]";
  }
}

function writeTranscript(messages: Message[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => jsonStringifySafe(m)).join("\n");
  fs.writeFileSync(p, lines + "\n", "utf8");
  return p;
}

async function summarizeHistory(messages: Message[]): Promise<string> {
  const conversation = jsonStringifySafe(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve:\n" +
    "1. The current goal\n" +
    "2. Important findings and decisions\n" +
    "3. Files read or changed\n" +
    "4. Remaining work\n" +
    "5. User constraints and preferences\n" +
    "Be compact but concrete.\n\n" +
    conversation;
  const response = await callChatCompletion([{ role: "user", content: prompt }], undefined, undefined);
  return String(response.content).trim() || "";
}

async function compactHistory(messages: Message[], state: CompactState, focus?: string | null): Promise<Message[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);

  let summary = await summarizeHistory(messages);
  if (focus) summary += `\n\nFocus to preserve next: ${focus}`;
  if (state.recentFiles.length) {
    const recentLines = state.recentFiles.map((p) => `- ${p}`).join("\n");
    summary += `\n\nRecent files to reopen if needed:\n${recentLines}`;
  }

  state.hasCompacted = true;
  state.lastSummary = summary;

  return [
    {
      role: "user",
      content:
        "This conversation was compacted so the agent can continue working.\n\n" + summary,
    },
  ];
}

function runBash(command: string, toolUseId: string): string {
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
    const output = String(out).trim() || "(no output)";
    return persistLargeOutput(toolUseId, output);
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const msg = String(err?.message ?? e);
    if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) {
      return "Error: Timeout (120s)";
    }
    return `Error: ${msg}`;
  }
}

function runRead(filePath: string, toolUseId: string, state: CompactState, limit?: number | null): string {
  try {
    trackRecentFile(state, filePath);
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    const output = lines.join("\n");
    return persistLargeOutput(toolUseId, output);
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
    name: "compact",
    description: "Summarize earlier conversation so work can continue in a smaller context.",
    input_schema: {
      type: "object",
      properties: { focus: { type: "string" } },
    },
  },
]);

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as { text?: string }[]) {
    if (block?.text) texts.push(block.text);
  }
  return texts.join("\n").trim();
}

function executeTool(block: { name: string; id: string; input?: Record<string, unknown> }, state: CompactState): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (block.name === "bash") {
    return runBash(String(input.command), block.id);
  }
  if (block.name === "read_file") {
    return runRead(String(input.path), block.id, state, input.limit as number | undefined);
  }
  if (block.name === "write_file") {
    return runWrite(String(input.path), String(input.content));
  }
  if (block.name === "edit_file") {
    return runEdit(String(input.path), String(input.old_text), String(input.new_text));
  }
  if (block.name === "compact") {
    return "Compacting conversation...";
  }
  return `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: Message[], state: CompactState): Promise<void> {
  while (true) {
    microCompact(messages);

    if (estimateContextSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      messages.splice(0, messages.length, ...(await compactHistory(messages, state)));
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
    let manualCompact = false;
    let compactFocus: string | null = null;

    for (const call of toolCalls) {
      const output = executeTool({ name: call.function.name, id: call.id, input: getToolCallArgs(call) }, state);
      if (call.function.name === "compact") {
        manualCompact = true;
        const args = getToolCallArgs(call);
        compactFocus = (args.focus as string) ?? null;
      }

      console.log(`> ${call.function.name}: ${String(output).slice(0, 200)}`);
      results.push({ role: "tool", tool_call_id: call.id, content: String(output) });
    }

    messages.push(...results);

    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await compactHistory(messages, state, compactFocus)));
    }
  }
}

async function main(): Promise<void> {
  const history: Message[] = [];
  const compactState: CompactState = { hasCompacted: false, lastSummary: "", recentFiles: [] };

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms06 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      history.push({ role: "user", content: query });
      await agentLoop(history, compactState);

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
