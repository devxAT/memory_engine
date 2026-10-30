import type { ToolCallInfo, ToolResultInfo } from "../types.js";

export interface ToolObservation {
  call: ToolCallInfo;
  /** `undefined` if the call never received a result. */
  result?: ToolResultInfo;
}

/**
 * Tracks state from tool calls in code, not via the LLM. Each plugin owns its state type and
 * stores it under its own `name` in `CompactionEntry.details`.
 */
export interface ExtractorPlugin<S = unknown> {
  /** Key in `CompactionEntry.details`. */
  readonly name: string;
  createState(): S;
  /** `previous` is `details[name]` of the prior compaction: stored JSON, possibly absent. */
  mergePrevious(previous: unknown, state: S): void;
  observe(obs: ToolObservation, state: S): void;
  /** JSON-safe; stored in `details[name]`. */
  serialize(state: S): unknown;
  /** Appended to the summary when the context is built. An empty string adds nothing. */
  render(details: unknown): string;
}
