import type { ExtractorRegistry } from "./extractors/registry.js";
import {
  type CompactionEntry,
  CompactionError,
  isCompactionEntry,
  isMessageEntry,
  isPruneEntry,
  type MessageAccessor,
  type MessageEntry,
  type SessionEntry,
} from "./types.js";

export interface ContextEntries<TMsg> {
  /** The latest compaction on the path. It supersedes every earlier one. */
  compaction: CompactionEntry | undefined;
  /** Message entries the context keeps: from the compaction's first kept entry, or all. */
  messages: MessageEntry<TMsg>[];
}

/**
 * The message entries that make up the context. With a compaction, they start at its
 * `firstKeptEntryId`, so they include the kept entries before the compaction entry itself.
 */
export function resolveContextEntries<TMsg>(path: SessionEntry<TMsg>[]): ContextEntries<TMsg> {
  let compaction: CompactionEntry | undefined;
  for (let i = path.length - 1; i >= 0 && !compaction; i--) {
    const entry = path[i];
    if (isCompactionEntry(entry)) compaction = entry;
  }

  let start = 0;
  if (compaction) {
    const keptId = compaction.firstKeptEntryId;
    start = path.findIndex((entry) => entry.id === keptId);
    if (start === -1) {
      throw new CompactionError("missing_kept_entry", `Entry ${keptId} is not on the path`);
    }
  }
  return { compaction, messages: path.slice(start).filter((entry) => isMessageEntry(entry)) };
}

/** Replacement text per tool call ID from every prune entry on the path; later entries win. */
export function collectReplacements<TMsg>(path: SessionEntry<TMsg>[]): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const entry of path) {
    if (!isPruneEntry(entry)) continue;
    for (const item of entry.items) replacements.set(item.toolCallId, item.replacement);
  }
  return replacements;
}

/** `msg` with its replaced tool results substituted. Unaffected messages are returned as-is. */
export function applyReplacements<TMsg>(
  msg: TMsg,
  replacements: ReadonlyMap<string, string>,
  accessor: MessageAccessor<TMsg>,
): TMsg {
  if (replacements.size === 0) return msg;
  let out = msg;
  for (const result of accessor.getToolResults(msg)) {
    const replacement = replacements.get(result.toolCallId);
    if (replacement !== undefined) {
      out = accessor.replaceToolResult(out, result.toolCallId, replacement);
    }
  }
  return out;
}

/**
 * The summary as the model sees it: the LLM-written text plus the extractors' deterministic
 * blocks. The blocks are rendered here, at build time, and never stored in `summary`.
 */
export function renderSummary(
  summary: string,
  details: Record<string, unknown>,
  extractors: ExtractorRegistry,
): string {
  const rendered = extractors.render(details);
  return rendered ? `${summary}\n\n${rendered}` : summary;
}

/**
 * The messages sent to the model for `path` (root → leaf): the latest summary, the kept
 * window, and every message after it, with prune replacements applied. Nothing is converted;
 * only messages with replaced results are copied.
 */
export function buildContext<TMsg>(
  path: SessionEntry<TMsg>[],
  accessor: MessageAccessor<TMsg>,
  extractors: ExtractorRegistry,
): TMsg[] {
  const replacements = collectReplacements(path);
  const { compaction, messages } = resolveContextEntries(path);
  const context = messages.map((entry) => applyReplacements(entry.message, replacements, accessor));
  if (compaction) {
    const rendered = renderSummary(compaction.summary, compaction.details, extractors);
    context.unshift(accessor.createSummaryMessage(rendered));
  }
  return context;
}
