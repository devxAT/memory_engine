import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type CompactionEntry,
  CompactionError,
  DEFAULT_COMPACTION_SETTINGS,
  isCompactionEntry,
  isMessageEntry,
  isPruneEntry,
  type MessageEntry,
  type NewEntry,
  type PruneEntry,
  type SessionEntry,
} from "../../src/compaction/types.js";

interface Msg {
  text: string;
}

const base = { parentId: null, timestamp: "2026-10-31T00:00:00.000Z" };

const messageEntry: MessageEntry<Msg> = {
  ...base,
  id: "m1",
  type: "message",
  message: { text: "hello" },
};

const compactionEntry: CompactionEntry = {
  ...base,
  id: "c1",
  type: "compaction",
  summary: "## Goal\nShip it.",
  firstKeptEntryId: "m1",
  tokensBefore: 1000,
  tokensAfter: 100,
  details: {},
  reason: "threshold",
  promptVersion: "1",
};

const pruneEntry: PruneEntry = {
  ...base,
  id: "p1",
  type: "prune",
  strategy: "proactive",
  items: [{ toolCallId: "call_1", replacement: "[truncated]", tokensBefore: 500, tokensAfter: 10 }],
};

const labelEntry: SessionEntry<Msg> = { ...base, id: "l1", type: "label", label: "checkpoint" };

const entries: SessionEntry<Msg>[] = [messageEntry, compactionEntry, pruneEntry, labelEntry];

describe("entry guards", () => {
  it("match only their own entry type and ignore unknown types", () => {
    expect(entries.map((e) => isMessageEntry(e))).toEqual([true, false, false, false]);
    expect(entries.map((e) => isCompactionEntry(e))).toEqual([false, true, false, false]);
    expect(entries.map((e) => isPruneEntry(e))).toEqual([false, false, true, false]);
  });

  it("narrow SessionEntry to the matching entry type", () => {
    for (const entry of entries) {
      if (isMessageEntry(entry)) expectTypeOf(entry.message).toEqualTypeOf<Msg>();
      if (isCompactionEntry(entry)) expectTypeOf(entry).toEqualTypeOf<CompactionEntry>();
      if (isPruneEntry(entry)) expectTypeOf(entry.items).toEqualTypeOf<PruneEntry["items"]>();
    }
  });
});

describe("NewEntry", () => {
  it("omits the fields the session store assigns", () => {
    expectTypeOf<NewEntry<PruneEntry>>().not.toHaveProperty("id");
    expectTypeOf<NewEntry<PruneEntry>>().not.toHaveProperty("parentId");
    expectTypeOf<NewEntry<PruneEntry>>().not.toHaveProperty("timestamp");
    expectTypeOf<NewEntry<PruneEntry>>().toHaveProperty("items");
    expectTypeOf<NewEntry<CompactionEntry>>().toHaveProperty("summary");
  });
});

describe("CompactionError", () => {
  it("carries its code and defaults the message to the code", () => {
    const err = new CompactionError("summary_not_smaller");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CompactionError);
    expect(err.name).toBe("CompactionError");
    expect(err.code).toBe("summary_not_smaller");
    expect(err.message).toBe("summary_not_smaller");
  });

  it("uses a custom message and keeps the cause", () => {
    const cause = new Error("upstream abort");
    const err = new CompactionError("aborted", "summarizer aborted", { cause });

    expect(err.code).toBe("aborted");
    expect(err.message).toBe("summarizer aborted");
    expect(err.cause).toBe(cause);
  });
});

describe("DEFAULT_COMPACTION_SETTINGS", () => {
  it("matches the documented defaults (architecture/compaction.md §2.4)", () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      summaryMaxTokens: 8192,
      maxSummarizerInputTokens: 100000,
      serializerMaxToolResultChars: 2000,
      micro: {
        strategy: "proactive",
        keepRecentToolResults: 5,
        maxToolResultTokens: 1000,
        preserveHeadLines: 20,
        preserveTailLines: 20,
        maxLineChars: 500,
        reactiveTargetRatio: 0.7,
        supersededReads: true,
        rules: [],
      },
      topology: "rolling_delta",
    });
  });
});
