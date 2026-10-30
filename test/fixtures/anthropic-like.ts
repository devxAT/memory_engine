import type { MessageAccessor, MessageOrigin, ToolResultInfo } from "../../src/compaction/types.js";

// Anthropic Messages-style test messages: tool results are blocks inside "user" messages, often
// next to harness-injected text; server-side tools put call and result in the same assistant
// message; thinking blocks are opaque. `injected` stands in for host metadata.

export interface AnText {
  type: "text";
  text: string;
}

export interface AnImage {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface AnThinking {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnText | AnImage>;
  is_error?: boolean;
}

export interface AnServerToolUse {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnSearchHit {
  type: "web_search_result";
  url: string;
  title: string;
}

export interface AnWebSearchResult {
  type: "web_search_tool_result";
  tool_use_id: string;
  /** A string only after the result has been replaced. */
  content: string | AnSearchHit[];
}

export type AnBlock =
  | AnText
  | AnImage
  | AnThinking
  | AnToolUse
  | AnToolResult
  | AnServerToolUse
  | AnWebSearchResult;

export interface AnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnMessage {
  role: "user" | "assistant";
  content: string | AnBlock[];
  usage?: AnUsage;
  /** Set when the host injected the whole message (reminders, summaries). */
  injected?: boolean;
}

function blocksOf(msg: AnMessage): AnBlock[] {
  return typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
}

function resultText(content: AnToolResult["content"] | AnWebSearchResult["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((b) => {
      if (b.type === "text") return [b.text];
      if (b.type === "web_search_result") return [`${b.title} ${b.url}`];
      return [];
    })
    .join("\n");
}

export const anAccessor: MessageAccessor<AnMessage> = {
  getOrigin(msg): MessageOrigin {
    if (msg.role === "assistant") return "model";
    if (blocksOf(msg).some((b) => b.type === "tool_result")) return "tool";
    return msg.injected ? "harness" : "human";
  },

  getToolCalls(msg) {
    return blocksOf(msg).flatMap((b) =>
      b.type === "tool_use" || b.type === "server_tool_use"
        ? [{ id: b.id, name: b.name, arguments: b.input }]
        : [],
    );
  },

  getToolResults(msg) {
    return blocksOf(msg).flatMap((b): ToolResultInfo[] => {
      if (b.type === "tool_result") {
        const images =
          typeof b.content === "string" ? 0 : b.content.filter((c) => c.type === "image").length;
        return [
          {
            toolCallId: b.tool_use_id,
            text: resultText(b.content),
            imageCount: images,
            isError: b.is_error ?? false,
          },
        ];
      }
      if (b.type === "web_search_tool_result") {
        return [
          { toolCallId: b.tool_use_id, text: resultText(b.content), imageCount: 0, isError: false },
        ];
      }
      return [];
    });
  },

  replaceToolResult(msg, toolCallId, text) {
    if (typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((b) =>
        (b.type === "tool_result" || b.type === "web_search_tool_result") &&
        b.tool_use_id === toolCallId
          ? { ...b, content: text }
          : b,
      ),
    };
  },

  toText(msg) {
    return blocksOf(msg)
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n");
  },

  createSummaryMessage(renderedSummary) {
    return { role: "user", content: [{ type: "text", text: renderedSummary }], injected: true };
  },

  getUsage(msg) {
    if (msg.role !== "assistant" || !msg.usage) return undefined;
    const u = msg.usage;
    return {
      inputTokens:
        u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    };
  },
};

/** Builders that keep test conversations short. */
export const an = {
  user: (content: string | AnBlock[]): AnMessage => ({ role: "user", content }),

  harness: (text: string): AnMessage => ({ role: "user", content: text, injected: true }),

  assistant(content: string | AnBlock[], usage?: AnUsage): AnMessage {
    const msg: AnMessage = { role: "assistant", content };
    if (usage) msg.usage = usage;
    return msg;
  },

  text: (text: string): AnText => ({ type: "text", text }),

  image: (): AnImage => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  }),

  thinking: (thinking: string): AnThinking => ({ type: "thinking", thinking, signature: "sig" }),

  toolUse: (id: string, name: string, input: Record<string, unknown> = {}): AnToolUse => ({
    type: "tool_use",
    id,
    name,
    input,
  }),

  toolResult(
    toolUseId: string,
    content: string | Array<AnText | AnImage>,
    isError = false,
  ): AnToolResult {
    const block: AnToolResult = { type: "tool_result", tool_use_id: toolUseId, content };
    if (isError) block.is_error = true;
    return block;
  },

  serverToolUse: (
    id: string,
    name: string,
    input: Record<string, unknown> = {},
  ): AnServerToolUse => ({ type: "server_tool_use", id, name, input }),

  webSearchResult: (
    toolUseId: string,
    hits: Array<{ title: string; url: string }>,
  ): AnWebSearchResult => ({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: hits.map((h) => ({ type: "web_search_result", ...h })),
  }),
};
