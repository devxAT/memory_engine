import { buildContext, collectReplacements, resolveContextEntries } from "./context.js";
import { FileOpsExtractor } from "./extractors/file-ops.js";
import { ExtractorRegistry } from "./extractors/registry.js";
import type { ExtractorPlugin } from "./extractors/types.js";
import { MacroSummarizer } from "./macro/summarizer.js";
import { ProactiveMicroStrategy } from "./micro/proactive.js";
import { ReactiveMicroStrategy } from "./micro/reactive.js";
import type { MicroContext, MicroStrategy } from "./micro/types.js";
import { estimateMessage, measureContext } from "./tokens.js";
import { RollingDeltaCompactor } from "./topology/rolling-delta.js";
import type { CompactionContext, CompactionOutcome, CompactionTopology } from "./topology/types.js";
import {
  type CompactionEntry,
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  type MessageAccessor,
  type ModelBudget,
  type NewEntry,
  type PruneEntry,
  type SessionEntry,
  type SummarizerFn,
} from "./types.js";

export type CompactionSettingsInput = Partial<Omit<CompactionSettings, "micro">> & {
  micro?: Partial<CompactionSettings["micro"]>;
};

export interface CompactionEngineDeps<TMsg> {
  accessor: MessageAccessor<TMsg>;
  summarize: SummarizerFn;
  /** Default: `[new FileOpsExtractor()]`. */
  extractors?: ExtractorPlugin[];
  /** Merged over the defaults; `micro` is merged one level deep. */
  settings?: CompactionSettingsInput;
  /** Host-supplied model/provider label, recorded in each compaction for evaluation. */
  summarizerLabel?: string;
}

/** `input` over the defaults, as a fresh object that shares nothing with them. */
export function resolveSettings(input: CompactionSettingsInput = {}): CompactionSettings {
  const micro = { ...DEFAULT_COMPACTION_SETTINGS.micro, ...input.micro };
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...input,
    micro: { ...micro, rules: [...micro.rules] },
  };
}

/**
 * What the host calls around every model request:
 * 1. `planMicro`, appending the returned prune entry, if any;
 * 2. if `shouldCompact`, `compact({ reason: "threshold" })`, appending the entry if compacted;
 * 3. `buildContext`, and send the request.
 * On a provider context-overflow error, `compact({ reason: "overflow" })` and retry once.
 */
export class CompactionEngine<TMsg> {
  readonly settings: CompactionSettings;
  private readonly accessor: MessageAccessor<TMsg>;
  private readonly extractors: ExtractorRegistry;
  private readonly estimate: (msg: TMsg) => number;
  private readonly micro: MicroStrategy;
  private readonly microContext: MicroContext<TMsg>;
  private readonly topology: CompactionTopology<TMsg>;
  private readonly compactionContext: CompactionContext<TMsg>;

  constructor(deps: CompactionEngineDeps<TMsg>) {
    const plugins = deps.extractors ?? [new FileOpsExtractor()];
    this.settings = resolveSettings(deps.settings);
    this.accessor = deps.accessor;
    this.extractors = new ExtractorRegistry(plugins);
    this.estimate = (msg) => estimateMessage(msg, deps.accessor);

    this.micro =
      this.settings.micro.strategy === "reactive"
        ? new ReactiveMicroStrategy()
        : new ProactiveMicroStrategy();
    this.microContext = {
      accessor: deps.accessor,
      settings: this.settings.micro,
      fileOps: plugins.find((p): p is FileOpsExtractor => p instanceof FileOpsExtractor),
    };

    this.topology = new RollingDeltaCompactor<TMsg>();
    this.compactionContext = {
      accessor: deps.accessor,
      extractors: this.extractors,
      summarizer: new MacroSummarizer(deps.summarize, deps.accessor, this.settings),
      settings: this.settings,
      estimate: this.estimate,
      summarizerLabel: deps.summarizerLabel,
    };
  }

  /** The messages to send to the model for `path` (root → leaf). */
  buildContext(path: SessionEntry<TMsg>[]): TMsg[] {
    return buildContext(path, this.accessor, this.extractors);
  }

  /** Tokens of the context `buildContext` produces, anchored on provider usage when possible. */
  measure(path: SessionEntry<TMsg>[], budget: ModelBudget): number {
    return measureContext(path, budget, {
      accessor: this.accessor,
      estimate: this.estimate,
      buildContext: (p) => this.buildContext(p),
    });
  }

  /** Stage 1: pruning decisions for the host to append, or `null` when there is nothing to prune. */
  planMicro(path: SessionEntry<TMsg>[], budget: ModelBudget): NewEntry<PruneEntry> | null {
    if (!this.settings.enabled) return null;
    const { messages } = resolveContextEntries(path);
    return this.micro.plan(
      {
        messages: messages.map((entry) => entry.message),
        replaced: new Set(collectReplacements(path).keys()),
        measured: this.measure(path, budget),
        threshold: this.threshold(budget),
      },
      this.microContext,
    );
  }

  shouldCompact(path: SessionEntry<TMsg>[], budget: ModelBudget): boolean {
    return this.settings.enabled && this.measure(path, budget) > this.threshold(budget);
  }

  /**
   * Stage 2: summarizes everything before a new cut point. `reason` defaults to "manual";
   * "overflow" keeps only half of `keepRecentTokens`. A failure rejects and produces no entry.
   */
  async compact(
    path: SessionEntry<TMsg>[],
    budget: ModelBudget,
    opts: { reason?: CompactionEntry["reason"]; signal?: AbortSignal } = {},
  ): Promise<CompactionOutcome> {
    const reason = opts.reason ?? "manual";
    return this.topology.compact(path, this.compactionContext, {
      reason,
      tokensBefore: this.measure(path, budget),
      keepRecentTokens:
        reason === "overflow" ? Math.floor(this.settings.keepRecentTokens / 2) : undefined,
      signal: opts.signal,
    });
  }

  private threshold(budget: ModelBudget): number {
    return budget.contextWindow - this.settings.reserveTokens;
  }
}
