import {
  isCompactionEntry,
  isMessageEntry,
  isPruneEntry,
  type MessageAccessor,
  type ModelBudget,
  type SessionEntry,
} from "./types.js";

/** Characters per token assumed by the heuristic estimator. */
export const CHARS_PER_TOKEN = 4;

/** Default token cost of one image in a tool result. */
export const DEFAULT_IMAGE_TOKENS = 1200;

/** Estimate for plain text such as summaries and serialized transcripts. */
export function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Default per-message estimate, replaced entirely by `accessor.estimateTokens` when the host
 * provides it. Opaque content (e.g. thinking) is invisible to the accessor and not counted, so
 * provider-reported usage is preferred whenever it is available.
 */
export function estimateMessage<TMsg>(
  msg: TMsg,
  accessor: MessageAccessor<TMsg>,
  imageTokens = DEFAULT_IMAGE_TOKENS,
): number {
  const override = accessor.estimateTokens?.(msg);
  if (override !== undefined) return override;

  let chars = accessor.toText(msg).length;
  for (const call of accessor.getToolCalls(msg)) {
    chars += call.name.length + (call.rawArguments ?? JSON.stringify(call.arguments ?? {})).length;
  }
  let images = 0;
  for (const result of accessor.getToolResults(msg)) {
    chars += result.text.length;
    images += result.imageCount;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * imageTokens;
}

export interface MeasureDeps<TMsg> {
  accessor: MessageAccessor<TMsg>;
  estimate: (msg: TMsg) => number;
  /** The context exactly as sent to the model. Only called when usage cannot be used. */
  buildContext: (path: SessionEntry<TMsg>[]) => TMsg[];
}

/**
 * Tokens of the context built from `path`. Anchors on the latest provider-reported usage and
 * estimates only what was appended after it. Falls back to estimating the whole built context
 * when no message has usage, or when a compaction was appended after it (that usage describes
 * a context that no longer exists).
 */
export function measureContext<TMsg>(
  path: SessionEntry<TMsg>[],
  budget: ModelBudget,
  deps: MeasureDeps<TMsg>,
): number {
  const { accessor, estimate } = deps;

  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (isCompactionEntry(entry)) break;
    if (!isMessageEntry(entry)) continue;
    const usage = accessor.getUsage?.(entry.message);
    if (!usage) continue;

    // Messages after the anchor are estimated raw, so every prune appended after it is
    // subtracted, whether its result sits before the anchor (counted in usage) or after it.
    let tokens = usage.inputTokens + usage.outputTokens;
    for (let j = i + 1; j < path.length; j++) {
      const later = path[j];
      if (isMessageEntry(later)) {
        tokens += estimate(later.message);
      } else if (isPruneEntry(later)) {
        for (const item of later.items) tokens -= item.tokensBefore - item.tokensAfter;
      }
    }
    return tokens;
  }

  let tokens = budget.overheadTokens ?? 0;
  for (const msg of deps.buildContext(path)) tokens += estimate(msg);
  return tokens;
}
