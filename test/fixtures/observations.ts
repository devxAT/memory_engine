import type { ToolObservation } from "../../src/compaction/extractors/types.js";

let nextId = 0;

/**
 * A tool call and its outcome: "ok" (default), "error", or "none" (never answered).
 * `args` is left `undefined` when omitted, like arguments that failed to parse.
 */
export function observation(
  name: string,
  args?: Record<string, unknown>,
  outcome: "ok" | "error" | "none" = "ok",
): ToolObservation {
  const id = `call_${nextId++}`;
  const call = { id, name, arguments: args };
  if (outcome === "none") return { call };
  return {
    call,
    result: { toolCallId: id, text: "", imageCount: 0, isError: outcome === "error" },
  };
}
