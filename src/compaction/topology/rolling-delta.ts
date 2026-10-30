import {
  applyReplacements,
  collectReplacements,
  renderSummary,
  resolveContextEntries,
} from "../context.js";
import type { ToolObservation } from "../extractors/types.js";
import { pairToolCalls } from "../groups.js";
import { findCutPoint } from "../macro/cut-point.js";
import { PROMPT_VERSION } from "../macro/prompts.js";
import { estimateText } from "../tokens.js";
import {
  type CompactionEntry,
  CompactionError,
  type NewEntry,
  type SessionEntry,
} from "../types.js";
import type {
  CompactionContext,
  CompactionOutcome,
  CompactionTopology,
  CompactOptions,
} from "./types.js";

/**
 * Keeps a single rolling summary. Each compaction folds everything before the new cut point,
 * starting at the previous compaction's kept window, into an update of the previous summary.
 */
export class RollingDeltaCompactor<TMsg> implements CompactionTopology<TMsg> {
  readonly name = "rolling_delta";

  async compact(
    path: SessionEntry<TMsg>[],
    ctx: CompactionContext<TMsg>,
    opts: CompactOptions,
  ): Promise<CompactionOutcome> {
    const { accessor, settings, estimate } = ctx;

    // Slots start at the previous compaction's kept window: those messages were never
    // summarized, so they must be summarized now or they are lost.
    const { compaction: prev, messages: slots } = resolveContextEntries(path);
    const replacements = collectReplacements(path);
    const raw = slots.map((slot) => slot.message);
    const tokens = raw.map((msg) => estimate(applyReplacements(msg, replacements, accessor)));
    const { resultIndex, validCut } = pairToolCalls(raw, accessor);
    const isTurnStart = raw.map(
      (msg) => accessor.isTurnStart?.(msg) ?? accessor.getOrigin(msg) === "human",
    );

    const cut = findCutPoint(
      tokens,
      validCut,
      isTurnStart,
      opts.keepRecentTokens ?? settings.keepRecentTokens,
    );
    if (!cut) return { status: "nothing_to_compact" };

    const { firstKeptIndex } = cut;
    // A turn prefix too large for one summarizer call is folded into the history; the
    // summary's Goal section then carries the original request.
    const isSplitTurn =
      cut.isSplitTurn &&
      sum(tokens, cut.turnStartIndex, firstKeptIndex) <= settings.maxSummarizerInputTokens;
    const historyEnd = isSplitTurn ? cut.turnStartIndex : firstKeptIndex;

    const observations: ToolObservation[] = [];
    for (const msg of raw.slice(0, firstKeptIndex)) {
      for (const call of accessor.getToolCalls(msg)) {
        const r = resultIndex.get(call.id);
        const result =
          r === undefined
            ? undefined
            : accessor.getToolResults(raw[r]).find((res) => res.toolCallId === call.id);
        observations.push(result ? { call, result } : { call });
      }
    }
    const details = ctx.extractors.run(observations, prev?.details);

    const summary = await ctx.summarizer.run({
      history: raw.slice(0, historyEnd),
      turnPrefix: raw.slice(historyEnd, firstKeptIndex),
      previousSummary: prev?.summary,
      signal: opts.signal,
    });

    const replaced = estimateText(prev?.summary ?? "") + sum(tokens, 0, firstKeptIndex);
    if (estimateText(summary) >= replaced) {
      throw new CompactionError(
        "summary_not_smaller",
        `Summary (${estimateText(summary)} tokens) is not smaller than what it replaces (${replaced})`,
      );
    }

    const summaryMessage = accessor.createSummaryMessage(
      renderSummary(summary, details, ctx.extractors),
    );
    const entry: NewEntry<CompactionEntry> = {
      type: "compaction",
      summary,
      firstKeptEntryId: slots[firstKeptIndex].id,
      tokensBefore: opts.tokensBefore,
      tokensAfter: estimate(summaryMessage) + sum(tokens, firstKeptIndex, tokens.length),
      details,
      reason: opts.reason,
      promptVersion: PROMPT_VERSION,
    };
    if (ctx.summarizerLabel !== undefined) entry.summarizerLabel = ctx.summarizerLabel;
    return { status: "compacted", entry };
  }
}

function sum(values: number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) total += values[i];
  return total;
}
