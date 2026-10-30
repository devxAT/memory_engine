import { describe, expect, it } from "vitest";
import { FileOpsExtractor } from "../../../src/compaction/extractors/file-ops.js";
import { ProactiveMicroStrategy } from "../../../src/compaction/micro/proactive.js";
import { ReactiveMicroStrategy } from "../../../src/compaction/micro/reactive.js";
import type { MicroStrategy } from "../../../src/compaction/micro/types.js";
import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
} from "../../../src/compaction/types.js";
import { type OaMessage, oa, oaAccessor } from "../../fixtures/openai-like.js";

type MicroSettings = CompactionSettings["micro"];

function plan(
  strategy: MicroStrategy,
  messages: OaMessage[],
  pressure: { measured: number; threshold: number },
  settings: Partial<MicroSettings> = {},
) {
  return strategy.plan(
    { messages, replaced: new Set(), ...pressure },
    {
      accessor: oaAccessor,
      settings: { ...DEFAULT_COMPACTION_SETTINGS.micro, keepRecentToolResults: 0, ...settings },
      fileOps: new FileOpsExtractor(),
    },
  );
}

const ids = (entry: ReturnType<typeof plan>) => entry?.items.map((item) => item.toolCallId);

// Single-line outputs are cut to 500 characters (129 tokens), so each saves its size − 129:
// x1 ≈ 1,871 tokens, x2 ≈ 5,871 tokens, x3 ≈ 3,871 tokens.
const messages = [
  oa.user("collect the logs"),
  ...oa.toolTurn("x1", "bash", { command: "cat a.log" }, "a".repeat(8000)),
  ...oa.toolTurn("x2", "bash", { command: "cat b.log" }, "b".repeat(24000)),
  ...oa.toolTurn("x3", "bash", { command: "cat c.log" }, "c".repeat(16000)),
];

describe("ProactiveMicroStrategy", () => {
  const proactive = new ProactiveMicroStrategy();

  it("prunes every candidate into one proactive prune entry, in context order", () => {
    const entry = plan(proactive, messages, { measured: 0, threshold: 100_000 });

    expect(entry).toEqual({
      type: "prune",
      strategy: "proactive",
      items: [
        expect.objectContaining({ toolCallId: "x1", tokensBefore: 2000, tokensAfter: 129 }),
        expect.objectContaining({ toolCallId: "x2", tokensBefore: 6000, tokensAfter: 129 }),
        expect.objectContaining({ toolCallId: "x3", tokensBefore: 4000, tokensAfter: 129 }),
      ],
    });
  });

  it("returns null when nothing qualifies", () => {
    expect(
      plan(proactive, messages, { measured: 0, threshold: 100_000 }, { keepRecentToolResults: 3 }),
    ).toBeNull();
  });
});

describe("ReactiveMicroStrategy", () => {
  const reactive = new ReactiveMicroStrategy();
  const threshold = 10_000; // target with the default 0.7 ratio: 7,000

  it("does nothing at or under the threshold", () => {
    expect(plan(reactive, messages, { measured: threshold, threshold })).toBeNull();
  });

  it("prunes the largest savings first and stops at the target ratio", () => {
    const entry = plan(reactive, messages, { measured: 12_000, threshold });

    expect(entry?.strategy).toBe("reactive");
    expect(ids(entry)).toEqual(["x2"]); // 12,000 − 5,871 ≤ 7,000
  });

  it("keeps pruning until the target is reached, emitting items in context order", () => {
    // 14,000 − 5,871 = 8,129 > 7,000, so x3 follows x2 before the target is reached.
    expect(ids(plan(reactive, messages, { measured: 14_000, threshold }))).toEqual(["x2", "x3"]);
  });

  it("prunes every candidate when the target cannot be reached", () => {
    expect(ids(plan(reactive, messages, { measured: 30_000, threshold }))).toEqual([
      "x1",
      "x2",
      "x3",
    ]);
  });

  it("uses the configured target ratio", () => {
    const entry = plan(
      reactive,
      messages,
      { measured: 14_000, threshold },
      { reactiveTargetRatio: 0.9 },
    );

    expect(ids(entry)).toEqual(["x2"]); // 8,129 ≤ 9,000
  });

  it("returns null when over the threshold but nothing qualifies", () => {
    expect(
      plan(reactive, messages, { measured: 30_000, threshold }, { keepRecentToolResults: 3 }),
    ).toBeNull();
  });
});
