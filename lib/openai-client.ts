/**
 * OpenAI 兼容 API 客户端
 * 用于调用支持 OpenAI 格式的 API 端点（如阿里云 DashScope）
 */

import * as dotenv from "dotenv";
dotenv.config({ override: true });

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = process.env.MODEL_ID!;
const BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResponse {
  content: string | ToolCall[];
  stop_reason: string | null;
}

export async function callChatCompletion(
  messages: Message[],
  tools?: Tool[],
  systemPrompt?: string,
): Promise<ChatCompletionResponse> {
  const url = `${BASE_URL.replace(/\/$/, "")}/chat/completions`;

  const apiMessages: Message[] = [];

  // 如果有 system prompt，添加到消息列表开头
  if (systemPrompt) {
    apiMessages.push({ role: "system", content: systemPrompt });
  }

  // 添加其他消息
  for (const msg of messages) {
    if (msg.role === "system" && apiMessages.length > 0 && apiMessages[0].role === "system") {
      continue; // 跳过重复的 system 消息
    }
    apiMessages.push(msg);
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: apiMessages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    max_tokens: 8000,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  // 检查是否有 tool_calls
  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    return {
      content: choice.message.tool_calls,
      stop_reason: choice.finish_reason || "tool_calls",
    };
  }

  return {
    content: choice?.message?.content || "",
    stop_reason: choice?.finish_reason || "stop",
  };
}

// 将 Anthropic 风格工具定义转换为 OpenAI 格式
export function convertTools(tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>): Tool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object" as const,
        properties: (tool.input_schema.properties as Record<string, unknown>) ?? {},
        required: (tool.input_schema.required as string[]) ?? [],
      },
    },
  }));
}

// 检查是否有工具调用
export function hasToolCalls(response: ChatCompletionResponse, toolName?: string): boolean {
  if (!Array.isArray(response.content)) return false;
  if (toolName) {
    return response.content.some(
      (call: ToolCall) => call.function?.name === toolName,
    );
  }
  return response.content.length > 0 && response.content.every((c: ToolCall) => c.type === "function");
}

// 提取工具调用参数
export function getToolCallArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return {};
  }
}
