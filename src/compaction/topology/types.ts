import type { ExtractorRegistry } from "../extractors/registry.js";
import type { MacroSummarizer } from "../macro/summarizer.js";
import type {
  CompactionEntry,
  CompactionSettings,
  MessageAccessor,
  NewEntry,
  SessionEntry,
} from "../types.js";

export interface CompactionContext<TMsg> {
  accessor: MessageAccessor<TMsg>;
  extractors: ExtractorRegistry;
  summarizer: MacroSummarizer<TMsg>;
  settings: CompactionSettings;
  estimate: (msg: TMsg) => number;
  summarizerLabel?: string;
}

export interface CompactOptions {
  reason: CompactionEntry["reason"];
  /** From `measure()`. */
  tokensBefore: number;
  /** Overflow recovery passes a smaller value. */
  keepRecentTokens?: number;
  signal?: AbortSignal;
}

export type CompactionOutcome =
  | { status: "compacted"; entry: NewEntry<CompactionEntry> }
  | { status: "nothing_to_compact" };

/** Decides what gets summarized. */
export interface CompactionTopology<TMsg> {
  readonly name: CompactionSettings["topology"];
  compact(
    path: SessionEntry<TMsg>[],
    ctx: CompactionContext<TMsg>,
    opts: CompactOptions,
  ): Promise<CompactionOutcome>;
}
