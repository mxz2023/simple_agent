#!/usr/bin/env npx tsx
// Harness: the loop -- keep feeding real tool results back into the model.
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * This file teaches the smallest useful coding-agent pattern:
 *
 *     user message
 *       -> model reply
 *       -> if tool_use: execute tools
 *       -> write tool_result back to messages
 *       -> continue
 *
 * It intentionally keeps the loop small, but still makes the loop state explicit
 * so later chapters can grow from the same structure.
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { callChatCompletion, convertTools, hasToolCalls, getToolCallArgs, type Message, type Tool } from "./lib/openai-client";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to inspect and change the workspace. Act first, then report clearly.`;

const TOOLS = convertTools([
  {
    name: "bash",
    description: "Run a shell command in the current workspace.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
]);

interface LoopState {
  messages: Message[];
  turnCount: number;
  transitionReason: string | null;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const result = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 50_000_000,
    });
    const out = String(result).trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const msg = String(err?.message ?? e);
    if (err?.code === "ETIMEDOUT" || msg.toLowerCase().includes("timeout")) {
      return "Error: Timeout (120s)";
    }
    return `Error: ${msg}`;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as { text?: string }[]) {
    if (block && typeof block.text === "string" && block.text) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

async function executeToolCalls(
  responseContent: unknown[],
): Promise<Message[]> {
  const results: Message[] = [];
  for (const item of responseContent) {
    const toolCall = item as { id?: string; function?: { name?: string; arguments?: string } };
    if (!toolCall.function?.name || toolCall.function.name !== "bash") continue;

    const args = getToolCallArgs(toolCall);
    const command = String(args.command ?? "");
    console.log(`\x1b[33m$ ${command}\x1b[0m`);
    const out = runBash(command);
    console.log(out.slice(0, 200));
    results.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: out,
    });
  }
  return results;
}

async function runOneTurn(state: LoopState): Promise<boolean> {
  const response = await callChatCompletion(state.messages, TOOLS, SYSTEM);

  // 将工具调用转换为消息
  if (Array.isArray(response.content)) {
    state.messages.push({ role: "assistant", content: JSON.stringify(response.content) });
  } else {
    state.messages.push({ role: "assistant", content: response.content });
  }

  if (!hasToolCalls(response)) {
    state.transitionReason = null;
    return false;
  }

  const toolCalls = response.content as Array<{ id: string; function: { name: string; arguments: string } }>;
  const toolResults = await executeToolCalls(toolCalls);
  if (!toolResults.length) {
    state.transitionReason = null;
    return false;
  }

  state.messages.push(...toolResults);
  state.turnCount += 1;
  state.transitionReason = "tool_result";
  return true;
}

async function agentLoop(state: LoopState): Promise<void> {
  while (await runOneTurn(state)) {
    /* continue */
  }
}

async function main(): Promise<void> {
  const history: Message[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms01 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      history.push({ role: "user", content: query });
      const state: LoopState = {
        messages: history,
        turnCount: 1,
        transitionReason: null,
      };
      await agentLoop(state);

      const last = history[history.length - 1];
      const finalText = last ? extractText(last.content) : "";
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
