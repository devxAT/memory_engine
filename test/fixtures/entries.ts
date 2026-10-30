import type {
  CompactionEntry,
  MessageEntry,
  NewEntry,
  PruneEntry,
  PruneItem,
  SessionEntry,
} from "../../src/compaction/types.js";

export type NewSessionEntry<TMsg> =
  | NewEntry<MessageEntry<TMsg>>
  | NewEntry<CompactionEntry>
  | NewEntry<PruneEntry>
  | { type: string; [key: string]: unknown };

/** Links entries into a root → leaf path. Ids are `e0`, `e1`, … by position. */
export function buildPath<TMsg>(entries: NewSessionEntry<TMsg>[]): SessionEntry<TMsg>[] {
  return entries.map(
    (entry, i) =>
      ({
        ...entry,
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: new Date(Date.UTC(2026, 9, 31, 0, 0, i)).toISOString(),
      }) as SessionEntry<TMsg>,
  );
}

export const message = <TMsg>(msg: TMsg): NewEntry<MessageEntry<TMsg>> => ({
  type: "message",
  message: msg,
});

export const prune = (
  items: PruneItem[],
  strategy: PruneEntry["strategy"] = "proactive",
): NewEntry<PruneEntry> => ({ type: "prune", strategy, items });

export const compaction = (
  firstKeptEntryId: string,
  fields: Partial<NewEntry<CompactionEntry>> = {},
): NewEntry<CompactionEntry> => ({
  type: "compaction",
  summary: "## Goal\nKeep going.",
  firstKeptEntryId,
  tokensBefore: 0,
  tokensAfter: 0,
  details: {},
  reason: "threshold",
  promptVersion: "1",
  ...fields,
});
