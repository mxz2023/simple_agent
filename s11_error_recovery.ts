#!/usr/bin/env npx tsx
// Harness: resilience -- a robust agent recovers instead of crashing.
/**
 * s11_error_recovery.ts - Error Recovery
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

const MAX_RECOVERY_ATTEMPTS = 3;
const BACKOFF_BASE_DELAY = 1.0;
const BACKOFF_MAX_DELAY = 30.0;
const TOKEN_THRESHOLD = 50_000;

const CONTINUATION_MESSAGE =
  "Output limit hit. Continue directly from where you stopped -- " +
  "no recap, no repetition. Pick up mid-sentence if needed.";

function jsonStringifySafe(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function estimateTokens(messages: Message[]): number {
  return Math.floor(jsonStringifySafe(messages).length / 4);
}

async function autoCompact(messages: Message[]): Promise<Message[]> {
  const conversationText = jsonStringifySafe(messages).slice(0, 80_000);
  const prompt =
    "Summarize this conversation for continuity. Include:\n" +
    "1) Task overview and success criteria\n" +
    "2) Current state: completed work, files touched\n" +
    "3) Key decisions and failed approaches\n" +
    "4) Remaining next steps\n" +
    "Be concise but preserve critical details.\n\n" +
    conversationText;
  let summary: string;
  try {
    const response = await callChatCompletion([{ role: "user", content: prompt }], undefined, undefined);
    summary = String(response.content);
  } catch (e) {
    summary = `(compact failed: ${e}). Previous context lost.`;
  }

  const continuation =
    "This session continues from a previous conversation that was compacted. " +
    `Summary of prior context:\n\n${summary}\n\n` +
    "Continue from where we left off without re-asking the user.";
  return [{ role: "user", content: continuation }];
}

function backoffDelay(attempt: number): number {
  const delay = Math.min(BACKOFF_BASE_DELAY * 2 ** attempt, BACKOFF_MAX_DELAY);
  const jitter = Math.random();
  return delay + jitter;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isRetriableTransportError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket") ||
    msg.includes("rate limit") ||
    msg.includes("429")
  );
}

async function agentLoop(messages: Message[]): Promise<void> {
  let maxOutputRecoveryCount = 0;

  while (true) {
    let response: { content: string | unknown[]; stop_reason: string | null } | null = null;

    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        response = await callChatCompletion(messages, TOOLS, SYSTEM);
        break;
      } catch (e: unknown) {
        const errorBody = String(e).toLowerCase();

        if (errorBody.includes("overlong_prompt") || (errorBody.includes("prompt") && errorBody.includes("long"))) {
          console.log(`[Recovery] Prompt too long. Compacting... (attempt ${attempt + 1})`);
          messages.splice(0, messages.length, ...(await autoCompact(messages)));
          continue;
        }

        if (attempt < MAX_RECOVERY_ATTEMPTS) {
          const delay = backoffDelay(attempt);
          console.log(
            `[Recovery] API error: ${String(e)}. Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`,
          );
          await sleepMs(delay * 1000);
          continue;
        }

        console.log(`[Error] API call failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${String(e)}`);
        return;
      }
    }

    if (!response) {
      console.log("[Error] No response received.");
      return;
    }

    // 将工具调用转换为消息
    if (Array.isArray(response.content)) {
      messages.push({ role: "assistant", content: JSON.stringify(response.content) });
    } else {
      messages.push({ role: "assistant", content: response.content });
    }

    if (response.stop_reason === "max_tokens" || response.stop_reason === "length") {
      maxOutputRecoveryCount += 1;
      if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
        console.log(
          `[Recovery] max_tokens hit (${maxOutputRecoveryCount}/${MAX_RECOVERY_ATTEMPTS}). Injecting continuation...`,
        );
        messages.push({ role: "user", content: CONTINUATION_MESSAGE });
        continue;
      }
      console.log(`[Error] max_tokens recovery exhausted (${MAX_RECOVERY_ATTEMPTS} attempts). Stopping.`);
      return;
    }

    maxOutputRecoveryCount = 0;

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

    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[Recovery] Token estimate exceeds threshold. Auto-compacting...");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
  }
}

async function main(): Promise<void> {
  console.log("[Error recovery enabled: max_tokens / prompt_too_long / connection backoff]");
  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms11 >> \x1b[0m");
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
