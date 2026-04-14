#!/usr/bin/env npx tsx
// Harness: integration -- tools aren't just in your code.
/**
 * s19_mcp_plugin.ts - MCP & Plugin System
 *
 * Minimal stdio MCP client: line-delimited JSON-RPC over a child process.
 */

import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;

const WORKDIR = process.cwd();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
});
const MODEL = process.env.MODEL_ID!;

const PERMISSION_MODES = ["default", "auto"] as const;

class CapabilityPermissionGate {
  private static READ_PREFIXES = ["read", "list", "get", "show", "search", "query", "inspect"];
  private static HIGH_RISK_PREFIXES = ["delete", "remove", "drop", "shutdown"];

  mode: (typeof PERMISSION_MODES)[number];

  constructor(mode = "default") {
    this.mode = PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number])
      ? (mode as (typeof PERMISSION_MODES)[number])
      : "default";
  }

  normalize(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
    let serverName: string | null = null;
    let actualTool = toolName;
    let source = "native";
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__");
      serverName = parts[1] ?? null;
      actualTool = parts.slice(2).join("__");
      source = "mcp";
    }
    const lowered = actualTool.toLowerCase();
    let risk: "read" | "write" | "high";
    if (actualTool === "read_file" || CapabilityPermissionGate.READ_PREFIXES.some((p) => lowered.startsWith(p))) {
      risk = "read";
    } else if (actualTool === "bash") {
      const command = String(toolInput.command ?? "");
      risk = ["rm -rf", "sudo", "shutdown", "reboot"].some((t) => command.includes(t)) ? "high" : "write";
    } else if (CapabilityPermissionGate.HIGH_RISK_PREFIXES.some((p) => lowered.startsWith(p))) {
      risk = "high";
    } else {
      risk = "write";
    }
    return { source, server: serverName, tool: actualTool, risk };
  }

  check(toolName: string, toolInput: Record<string, unknown>): {
    behavior: "allow" | "ask";
    reason: string;
    intent: Record<string, unknown>;
  } {
    const intent = this.normalize(toolName, toolInput);
    if (intent.risk === "read") {
      return { behavior: "allow", reason: "Read capability", intent };
    }
    if (this.mode === "auto" && intent.risk !== "high") {
      return { behavior: "allow", reason: "Auto mode for non-high-risk capability", intent };
    }
    if (intent.risk === "high") {
      return { behavior: "ask", reason: "High-risk capability requires confirmation", intent };
    }
    return { behavior: "ask", reason: "State-changing capability requires confirmation", intent };
  }

  async askUser(
    intent: Record<string, unknown>,
    toolInput: Record<string, unknown>,
    rl: readlinePromises.Interface,
  ): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200);
    const source = intent.server
      ? `${intent.source}:${intent.server}/${intent.tool}`
      : `${intent.source}:${intent.tool}`;
    console.log(`\n  [Permission] ${source} risk=${intent.risk}: ${preview}`);
    try {
      const answer = (await rl.question("  Allow? (y/n): ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } catch {
      return false;
    }
  }
}

const permissionGate = new CapabilityPermissionGate();

class MCPClient {
  serverName: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  process: ChildProcessWithoutNullStreams | null = null;
  private _stdoutRl: readline.Interface | null = null;
  private _requestId = 0;
  private _tools: Array<Record<string, unknown>> = [];

  constructor(serverName: string, command: string, args: string[] = [], env?: Record<string, string>) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv;
  }

  private async _readJsonLine(): Promise<Record<string, unknown> | null> {
    if (!this._stdoutRl) return null;
    return await new Promise((resolve) => {
      this._stdoutRl!.once("line", (line) => {
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
      this._stdoutRl!.once("close", () => resolve(null));
    });
  }

  async connect(): Promise<boolean> {
    try {
      this.process = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
      this._stdoutRl = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });

      this._send({
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "teaching-agent", version: "1.0" },
        },
      });
      const response = await this._readJsonLine();
      if (response && "result" in response) {
        this._send({ method: "notifications/initialized" });
        return true;
      }
    } catch (e) {
      console.log(`[MCP] Connection failed: ${e}`);
    }
    return false;
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    this._send({ method: "tools/list", params: {} });
    const response = await this._readJsonLine();
    if (response && "result" in (response as { result?: { tools?: unknown[] } })) {
      const r = response as { result: { tools?: Array<Record<string, unknown>> } };
      this._tools = r.result.tools ?? [];
    }
    return this._tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    this._send({ method: "tools/call", params: { name: toolName, arguments: args } });
    const response = await this._readJsonLine();
    if (response && "result" in (response as { result?: { content?: unknown[] } })) {
      const r = response as { result: { content?: Array<{ text?: string } | string> } };
      const content = r.result.content ?? [];
      return content
        .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: string }).text) : String(c)))
        .join("\n");
    }
    if (response && "error" in (response as { error?: { message?: string } })) {
      const err = (response as { error: { message?: string } }).error;
      return `MCP Error: ${err.message ?? "unknown"}`;
    }
    return "MCP Error: no response";
  }

  getAgentTools(): Tool[] {
    const agentTools: Tool[] = [];
    for (const tool of this._tools) {
      const prefixedName = `mcp__${this.serverName}__${String(tool.name)}`;
      agentTools.push({
        name: prefixedName,
        description: String(tool.description ?? ""),
        input_schema: (tool.inputSchema ?? { type: "object", properties: {} }) as Tool["input_schema"],
      });
    }
    return agentTools;
  }

  disconnect(): void {
    try {
      this._send({ method: "shutdown" });
    } catch {
      /* ignore */
    }
    this._stdoutRl?.close();
    this._stdoutRl = null;
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
      } catch {
        this.process.kill("SIGKILL");
      }
    }
    this.process = null;
  }

  private _send(message: Record<string, unknown>): void {
    if (!this.process || this.process.killed) return;
    this._requestId += 1;
    const envelope = { jsonrpc: "2.0", id: this._requestId, ...message };
    const line = JSON.stringify(envelope) + "\n";
    try {
      this.process.stdin.write(line);
    } catch {
      /* ignore */
    }
  }
}

class PluginLoader {
  searchDirs: string[];
  plugins: Record<string, Record<string, unknown>> = {};

  constructor(searchDirs?: string[]) {
    this.searchDirs = searchDirs ?? [WORKDIR];
  }

  scan(): string[] {
    const found: string[] = [];
    for (const searchDir of this.searchDirs) {
      const manifestPath = path.join(searchDir, ".claude-plugin", "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const name = String(manifest.name ?? path.basename(path.dirname(manifestPath)));
        this.plugins[name] = manifest;
        found.push(name);
      } catch (e) {
        console.log(`[Plugin] Failed to load ${manifestPath}: ${e}`);
      }
    }
    return found;
  }

  getMcpServers(): Record<string, Record<string, unknown>> {
    const servers: Record<string, Record<string, unknown>> = {};
    for (const [pluginName, manifest] of Object.entries(this.plugins)) {
      const mcpServers = (manifest.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      for (const [serverName, config] of Object.entries(mcpServers)) {
        servers[`${pluginName}__${serverName}`] = config;
      }
    }
    return servers;
  }
}

class MCPToolRouter {
  clients: Record<string, MCPClient> = {};

  registerClient(client: MCPClient): void {
    this.clients[client.serverName] = client;
  }

  isMcpTool(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const parts = toolName.split("__");
    if (parts.length !== 3) return `Error: Invalid MCP tool name: ${toolName}`;
    const serverName = parts[1]!;
    const actualTool = parts[2]!;
    const c = this.clients[serverName];
    if (!c) return `Error: MCP server not found: ${serverName}`;
    return c.callTool(actualTool, args);
  }

  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const c of Object.values(this.clients)) {
      tools.push(...c.getAgentTools());
    }
    return tools;
  }
}

const mcpRouter = new MCPToolRouter();
const pluginLoader = new PluginLoader();

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const root = path.resolve(WORKDIR);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
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

function runRead(filePath: string): string {
  try {
    return fs.readFileSync(safePath(filePath), "utf8").slice(0, 50_000);
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
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

const NATIVE_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (kw) => runBash(String(kw.command)),
  read_file: (kw) => runRead(String(kw.path)),
  write_file: (kw) => runWrite(String(kw.path), String(kw.content)),
  edit_file: (kw) => runEdit(String(kw.path), String(kw.old_text), String(kw.new_text)),
};

const NATIVE_TOOLS: Tool[] = [
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
];

function buildToolPool(): Tool[] {
  const all = [...NATIVE_TOOLS];
  const mcpTools = mcpRouter.getAllTools();
  const nativeNames = new Set(all.map((t) => t.name));
  for (const t of mcpTools) {
    if (!nativeNames.has(t.name)) all.push(t);
  }
  return all;
}

async function handleToolCall(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  if (mcpRouter.isMcpTool(toolName)) return mcpRouter.call(toolName, toolInput);
  const h = NATIVE_HANDLERS[toolName];
  return h ? h(toolInput) : `Unknown tool: ${toolName}`;
}

function normalizeToolResult(toolName: string, output: string, intent?: Record<string, unknown>): string {
  const norm = intent ?? permissionGate.normalize(toolName, {});
  const status = output.includes("Error:") || output.includes("MCP Error:") ? "error" : "ok";
  const payload = {
    source: norm.source,
    server: norm.server,
    tool: norm.tool,
    risk: norm.risk,
    status,
    preview: output.slice(0, 500),
  };
  return JSON.stringify(payload, null, 2);
}

async function agentLoop(messages: MessageParam[], rl: readlinePromises.Interface): Promise<void> {
  const tools = buildToolPool();
  while (true) {
    const system =
      `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n` +
      "You have both native tools and MCP tools available.\n" +
      "MCP tools are prefixed with mcp__{server}__{tool}.\n" +
      "All capabilities pass through the same permission gate before execution.";
    const response = await client.messages.create({
      model: MODEL,
      system,
      messages,
      tools,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const decision = permissionGate.check(block.name, (block.input ?? {}) as Record<string, unknown>);
      let out: string;
      try {
        if (
          decision.behavior === "ask" &&
          !(await permissionGate.askUser(decision.intent, (block.input ?? {}) as Record<string, unknown>, rl))
        ) {
          out = `Permission denied by user: ${decision.reason}`;
        } else {
          out = await handleToolCall(block.name, (block.input ?? {}) as Record<string, unknown>);
        }
      } catch (e) {
        out = `Error: ${e}`;
      }
      console.log(`> ${block.name}: ${out.slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: normalizeToolResult(block.name, String(out), decision.intent as Record<string, unknown>),
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  const found = pluginLoader.scan();
  if (found.length) {
    console.log(`[Plugins loaded: ${found.join(", ")}]`);
    for (const [serverName, config] of Object.entries(pluginLoader.getMcpServers())) {
      const cmd = String((config as { command?: string }).command ?? "");
      const args = ((config as { args?: string[] }).args ?? []) as string[];
      const mcpClient = new MCPClient(serverName, cmd, args);
      if (await mcpClient.connect()) {
        await mcpClient.listTools();
        mcpRouter.registerClient(mcpClient);
        console.log(`[MCP] Connected to ${serverName}`);
      }
    }
  }

  console.log(`[Tool pool: ${buildToolPool().length} tools (${mcpRouter.getAllTools().length} from MCP)]`);

  const history: MessageParam[] = [];
  const rl = readlinePromises.createInterface({ input, output });
  try {
    while (true) {
      let query: string;
      try {
        query = await rl.question("\x1b[36ms19 >> \x1b[0m");
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "q" || q === "exit" || q === "") break;

      if (query.trim() === "/tools") {
        for (const tool of buildToolPool()) {
          const prefix = tool.name.startsWith("mcp__") ? "[MCP] " : "       ";
          console.log(`  ${prefix}${tool.name}: ${(tool.description ?? "").slice(0, 60)}`);
        }
        continue;
      }

      if (query.trim() === "/mcp") {
        if (Object.keys(mcpRouter.clients).length) {
          for (const [name, c] of Object.entries(mcpRouter.clients)) {
            console.log(`  ${name}: ${c.getAgentTools().length} tools`);
          }
        } else {
          console.log("  (no MCP servers connected)");
        }
        continue;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history, rl);
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
    for (const c of Object.values(mcpRouter.clients)) c.disconnect();
    rl.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
