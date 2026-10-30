import { estimateText } from "../tokens.js";
import type {
  CompactionSettings,
  NewEntry,
  PruneEntry,
  PruneItem,
  ToolCallInfo,
  ToolResultInfo,
} from "../types.js";
import {
  evictionStub,
  type TruncationLimits,
  toolResultTokens,
  truncateToolResult,
} from "./pruner.js";
import type { MicroContext, MicroInput } from "./types.js";

/**
 * A prune item for every tool result that may be pruned now, in context order. A result
 * qualifies when it is outside the most recent `keepRecentToolResults` results (counted in
 * results, not turns), has no replacement yet, and is either over its size limit or a file
 * read superseded by a later successful read or modification of the same path. Items that
 * would not save tokens are dropped.
 */
export function findPruneCandidates<TMsg>(
  input: Pick<MicroInput<TMsg>, "messages" | "replaced">,
  ctx: MicroContext<TMsg>,
): PruneItem[] {
  const { accessor, settings, fileOps } = ctx;
  const calls = new Map<string, { call: ToolCallInfo; order: number }>();
  const results: ToolResultInfo[] = [];
  for (const msg of input.messages) {
    for (const call of accessor.getToolCalls(msg)) {
      if (!calls.has(call.id)) calls.set(call.id, { call, order: calls.size });
    }
    results.push(...accessor.getToolResults(msg));
  }

  // Latest successful read or modification of each path, by call order.
  const lastTouch = new Map<string, number>();
  if (settings.supersededReads && fileOps) {
    const succeeded = new Set(results.filter((r) => !r.isError).map((r) => r.toolCallId));
    for (const { call, order } of calls.values()) {
      const op = succeeded.has(call.id) ? fileOps.classify(call) : undefined;
      if (op) lastTouch.set(op.path, order);
    }
  }

  const items: PruneItem[] = [];
  const seen = new Set<string>();
  const recentFrom = results.length - settings.keepRecentToolResults;
  for (let i = 0; i < recentFrom; i++) {
    const result = results[i];
    if (seen.has(result.toolCallId)) continue;
    seen.add(result.toolCallId);
    if (input.replaced.has(result.toolCallId)) continue;

    const entry = calls.get(result.toolCallId);
    const read = entry && fileOps?.classify(entry.call);
    const superseded =
      read?.kind === "read" &&
      entry !== undefined &&
      (lastTouch.get(read.path) ?? -1) > entry.order;
    const replacement = superseded
      ? evictionStub(read.path, result.text)
      : truncateToolResult(result, limitsFor(entry?.call.name, settings), ctx.imageTokens);
    if (replacement === null) continue;

    const tokensBefore = toolResultTokens(result, ctx.imageTokens);
    const tokensAfter = estimateText(replacement);
    if (tokensAfter < tokensBefore) {
      items.push({ toolCallId: result.toolCallId, replacement, tokensBefore, tokensAfter });
    }
  }
  return items;
}

export function toPruneEntry(
  strategy: PruneEntry["strategy"],
  items: PruneItem[],
): NewEntry<PruneEntry> | null {
  return items.length > 0 ? { type: "prune", strategy, items } : null;
}

/** The first rule naming the tool overrides the global limits. */
function limitsFor(
  toolName: string | undefined,
  settings: CompactionSettings["micro"],
): TruncationLimits {
  const rule =
    toolName === undefined ? undefined : settings.rules.find((r) => r.toolNames.includes(toolName));
  return {
    maxTokens: rule?.maxToolResultTokens ?? settings.maxToolResultTokens,
    preserveHeadLines: rule?.preserveHeadLines ?? settings.preserveHeadLines,
    preserveTailLines: rule?.preserveTailLines ?? settings.preserveTailLines,
    maxLineChars: settings.maxLineChars,
  };
}
