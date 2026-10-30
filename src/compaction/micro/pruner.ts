import { CHARS_PER_TOKEN, DEFAULT_IMAGE_TOKENS, estimateText } from "../tokens.js";
import type { ToolResultInfo } from "../types.js";

export interface TruncationLimits {
  /** `Infinity` = never truncate. */
  maxTokens: number;
  preserveHeadLines: number;
  preserveTailLines: number;
  maxLineChars: number;
}

/** Estimated tokens a tool result occupies in the context, images included. */
export function toolResultTokens(
  result: ToolResultInfo,
  imageTokens = DEFAULT_IMAGE_TOKENS,
): number {
  return estimateText(result.text) + result.imageCount * imageTokens;
}

/**
 * Replacement text for a result over `limits.maxTokens`, or `null` when it fits. Images are
 * always dropped; the text itself is only shortened when the text alone is over the limit.
 */
export function truncateToolResult(
  result: ToolResultInfo,
  limits: TruncationLimits,
  imageTokens = DEFAULT_IMAGE_TOKENS,
): string | null {
  if (toolResultTokens(result, imageTokens) <= limits.maxTokens) return null;
  const maxChars = limits.maxTokens * CHARS_PER_TOKEN;
  if (result.imageCount === 0) return truncateText(result.text, limits, maxChars);

  const note = `[${result.imageCount} image(s) removed]`;
  const text = truncateText(result.text, limits, maxChars - note.length - 1);
  return text ? `${text}\n${note}` : note;
}

/** Full replacement for a file read made stale by a later read or modification of `path`. */
export function evictionStub(path: string, text: string): string {
  return (
    `[Tool result evicted: ${path} was read again or modified later; ` +
    `original ${lineCount(text)} lines / ${text.length} chars]`
  );
}

function truncateText(text: string, limits: TruncationLimits, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // 1. Lines that stay visible are cut to maxLineChars.
  const { maxLineChars } = limits;
  const show = (line: string) =>
    line.length > maxLineChars
      ? `${line.slice(0, maxLineChars)}…[+${line.length - maxLineChars} chars]`
      : line;
  const lines = text.split("\n");
  const total = lines.length;
  const headCount = Math.min(limits.preserveHeadLines, total);
  const tailCount = Math.min(limits.preserveTailLines, total - headCount);

  // 2. Head and tail lines are kept around a stub.
  let head: string;
  let tail: string;
  if (headCount + tailCount < total) {
    head = lines.slice(0, headCount).map(show).join("\n");
    tail = lines
      .slice(total - tailCount)
      .map(show)
      .join("\n");
    const out = withStub(head, tail, text, total);
    if (out.length <= maxChars) return out;
  } else {
    const shown = lines.map(show).join("\n");
    if (shown.length <= maxChars) return shown;
    const mid = Math.ceil(shown.length / 2);
    head = shown.slice(0, mid);
    tail = shown.slice(mid);
  }

  // 3. Hard cut by characters, keeping the start of the head and the end of the tail. The
  // stub's longest possible form is reserved, so the result fits unless the stub alone does not.
  const room = Math.max(0, maxChars - stub(total, text.length, total).length - 2);
  const tailKeep = Math.min(tail.length, Math.max(Math.floor(room / 2), room - head.length));
  const headKeep = Math.min(head.length, room - tailKeep);
  return withStub(head.slice(0, headKeep), tail.slice(tail.length - tailKeep), text, total);
}

/** Joins the kept text around a stub that counts what the model no longer sees. */
function withStub(head: string, tail: string, original: string, totalLines: number): string {
  const h = head.endsWith("\n") ? head.slice(0, -1) : head;
  const t = tail.startsWith("\n") ? tail.slice(1) : tail;
  const omittedLines = Math.max(0, totalLines - lineCount(h) - lineCount(t));
  const omittedChars = Math.max(0, original.length - h.length - t.length);
  return [h, stub(omittedLines, omittedChars, totalLines), t].filter((s) => s !== "").join("\n");
}

function stub(omittedLines: number, omittedChars: number, totalLines: number): string {
  return `[... truncated ${omittedLines} lines / ${omittedChars} chars; original ${totalLines} lines ...]`;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}
