import type { MessageAccessor, MessageOrigin } from "../types.js";

export interface SerializeOptions {
  /** Per-result cap; longer results keep their head and tail. */
  maxToolResultChars: number;
  /** Per-call cap on the argument string. Default 500. */
  maxToolArgChars?: number;
}

/** Label for a message's own text. Text in a tool-origin message was injected by the host. */
const TEXT_LABEL: Record<MessageOrigin, string> = {
  human: "User",
  harness: "Harness",
  model: "Assistant",
  tool: "Harness",
  system: "System",
};

/**
 * A text transcript for the summarizer. Raw tool-call messages would tempt the model to
 * continue the conversation or call tools instead of summarizing.
 */
export function serializeConversation<TMsg>(
  messages: TMsg[],
  accessor: MessageAccessor<TMsg>,
  opts: SerializeOptions,
): string {
  return serializeBlocks(messages, accessor, opts).join("\n\n");
}

/**
 * One block per message with visible content. Result labels use the name of the matching call
 * seen earlier in `messages`. Opaque content is excluded because `toText` excludes it.
 */
export function serializeBlocks<TMsg>(
  messages: TMsg[],
  accessor: MessageAccessor<TMsg>,
  opts: SerializeOptions,
): string[] {
  const maxArgChars = opts.maxToolArgChars ?? 500;
  const toolNames = new Map<string, string>();
  const blocks: string[] = [];

  for (const msg of messages) {
    const origin = accessor.getOrigin(msg);
    const text = accessor.toText(msg);
    const textLine = text ? `[${TEXT_LABEL[origin]}]: ${text}` : undefined;
    const lines: string[] = [];

    if (textLine && origin !== "tool") lines.push(textLine);
    for (const call of accessor.getToolCalls(msg)) {
      toolNames.set(call.id, call.name);
      const args = call.rawArguments ?? JSON.stringify(call.arguments ?? {});
      lines.push(`[Assistant tool call] ${call.name} ${capEnd(args, maxArgChars)}`);
    }
    for (const result of accessor.getToolResults(msg)) {
      const name = toolNames.get(result.toolCallId);
      const label = `Tool result${name ? `: ${name}` : ""}${result.isError ? " (error)" : ""}`;
      lines.push(`[${label}]: ${capMiddle(result.text, opts.maxToolResultChars)}`);
    }
    // Tool results come first in their message; injected text follows them.
    if (textLine && origin === "tool") lines.push(textLine);

    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks;
}

function capEnd(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

function capMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return (
    `${text.slice(0, head)}\n[... ${text.length - max} chars truncated ...]\n` +
    text.slice(text.length - tail)
  );
}
