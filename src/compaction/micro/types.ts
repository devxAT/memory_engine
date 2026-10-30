import type { FileOpsExtractor } from "../extractors/file-ops.js";
import type { CompactionSettings, MessageAccessor, NewEntry, PruneEntry } from "../types.js";

export interface MicroContext<TMsg> {
  accessor: MessageAccessor<TMsg>;
  settings: CompactionSettings["micro"];
  /** Enables superseded-read detection; without it only size limits apply. */
  fileOps?: FileOpsExtractor;
  /** Token cost of one image; defaults to `DEFAULT_IMAGE_TOKENS`. */
  imageTokens?: number;
}

export interface MicroInput<TMsg> {
  /** Messages of the built context as stored, before prune replacements. */
  messages: TMsg[];
  /** Tool call IDs that earlier prune entries already replaced. */
  replaced: ReadonlySet<string>;
  /** Current context tokens, from `measure`. */
  measured: number;
  /** `contextWindow − reserveTokens`. */
  threshold: number;
}

export interface MicroStrategy {
  readonly name: PruneEntry["strategy"];
  /** Pruning decisions for the host to append, or `null` when there is nothing to prune. */
  plan<TMsg>(input: MicroInput<TMsg>, ctx: MicroContext<TMsg>): NewEntry<PruneEntry> | null;
}
