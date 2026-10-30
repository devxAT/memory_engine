import type { MessageAccessor, MessageOrigin } from "../../src/compaction/types.js";

// OpenAI Chat Completions-style test messages: every tool result is its own `role: "tool"`
// message and tool-call arguments are JSON strings. `injected` and `is_error` stand in for
// metadata a real host keeps next to the provider message.

export type OaPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OaUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface OaSystemMessage {
  role: "system";
  content: string;
}

export interface OaUserMessage {
  role: "user";
  content: string | OaPart[];
  /** Set when the host injected the message (reminders, summaries); never a turn start. */
  injected?: boolean;
}

export interface OaAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OaToolCall[];
  usage?: OaUsage;
}

export interface OaToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | OaPart[];
  is_error?: boolean;
}

export type OaMessage = OaSystemMessage | OaUserMessage | OaAssistantMessage | OaToolMessage;

function partsText(content: string | OaPart[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

function imageCount(content: string | OaPart[]): number {
  return typeof content === "string" ? 0 : content.filter((p) => p.type === "image_url").length;
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export const oaAccessor: MessageAccessor<OaMessage> = {
  getOrigin(msg): MessageOrigin {
    switch (msg.role) {
      case "system":
        return "system";
      case "user":
        return msg.injected ? "harness" : "human";
      case "assistant":
        return "model";
      case "tool":
        return "tool";
    }
  },

  getToolCalls(msg) {
    if (msg.role !== "assistant") return [];
    return (msg.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: parseArguments(c.function.arguments),
      rawArguments: c.function.arguments,
    }));
  },

  getToolResults(msg) {
    if (msg.role !== "tool") return [];
    return [
      {
        toolCallId: msg.tool_call_id,
        text: partsText(msg.content),
        imageCount: imageCount(msg.content),
        isError: msg.is_error ?? false,
      },
    ];
  },

  replaceToolResult(msg, toolCallId, text) {
    if (msg.role !== "tool" || msg.tool_call_id !== toolCallId) return msg;
    return { ...msg, content: text };
  },

  toText(msg) {
    switch (msg.role) {
      case "tool":
        return "";
      case "assistant":
        return msg.content ?? "";
      default:
        return partsText(msg.content);
    }
  },

  createSummaryMessage(renderedSummary) {
    return { role: "user", content: renderedSummary, injected: true };
  },

  getUsage(msg) {
    if (msg.role !== "assistant" || !msg.usage) return undefined;
    return { inputTokens: msg.usage.prompt_tokens, outputTokens: msg.usage.completion_tokens };
  },
};

/** Builders that keep test conversations short. */
export const oa = {
  system: (content: string): OaSystemMessage => ({ role: "system", content }),

  user: (content: string | OaPart[]): OaUserMessage => ({ role: "user", content }),

  harness: (content: string): OaUserMessage => ({ role: "user", content, injected: true }),

  assistant(content: string | null, calls: OaToolCall[] = [], usage?: OaUsage): OaAssistantMessage {
    const msg: OaAssistantMessage = { role: "assistant", content };
    if (calls.length > 0) msg.tool_calls = calls;
    if (usage) msg.usage = usage;
    return msg;
  },

  /** `args` objects are JSON-encoded; strings are used verbatim (e.g. to test invalid JSON). */
  call: (id: string, name: string, args: Record<string, unknown> | string = {}): OaToolCall => ({
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  }),

  tool(toolCallId: string, content: string | OaPart[], isError = false): OaToolMessage {
    const msg: OaToolMessage = { role: "tool", tool_call_id: toolCallId, content };
    if (isError) msg.is_error = true;
    return msg;
  },

  text: (text: string): OaPart => ({ type: "text", text }),

  image: (url = "data:image/png;base64,AAAA"): OaPart => ({
    type: "image_url",
    image_url: { url },
  }),
};
