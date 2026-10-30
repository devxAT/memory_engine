import type { MessageAccessor } from "./types.js";

export interface ToolPairing {
  /** Index of the message holding each call's result. The first occurrence of an ID wins. */
  resultIndex: Map<string, number>;
  /** `validCut[i]` is true when cutting before message `i` separates no call from its result. */
  validCut: boolean[];
}

/**
 * Pairs tool calls with their results by ID, not by role or message type. This covers parallel
 * calls, results spread over several messages, harness messages injected between results, and
 * server-side tools whose call and result share one message.
 */
export function pairToolCalls<TMsg>(
  messages: TMsg[],
  accessor: MessageAccessor<TMsg>,
): ToolPairing {
  const resultIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    for (const result of accessor.getToolResults(messages[i])) {
      if (!resultIndex.has(result.toolCallId)) resultIndex.set(result.toolCallId, i);
    }
  }

  const validCut = new Array<boolean>(messages.length).fill(true);
  for (let c = 0; c < messages.length; c++) {
    for (const call of accessor.getToolCalls(messages[c])) {
      const r = resultIndex.get(call.id);
      // Calls without a result (aborted) and results in the same message add no constraint.
      if (r === undefined || r <= c) continue;
      for (let k = c + 1; k <= r; k++) validCut[k] = false;
    }
  }

  return { resultIndex, validCut };
}
