import { describe, expect, it } from "vitest";
import { FileOpsExtractor } from "../../../src/compaction/extractors/file-ops.js";
import { findPruneCandidates } from "../../../src/compaction/micro/candidates.js";
import { evictionStub } from "../../../src/compaction/micro/pruner.js";
import { estimateText } from "../../../src/compaction/tokens.js";
import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  type MessageAccessor,
  type PruneItem,
} from "../../../src/compaction/types.js";
import { an, anAccessor } from "../../fixtures/anthropic-like.js";
import { type OaMessage, oa, oaAccessor } from "../../fixtures/openai-like.js";

type MicroSettings = CompactionSettings["micro"];

function candidates<TMsg>(
  accessor: MessageAccessor<TMsg>,
  messages: TMsg[],
  settings: Partial<MicroSettings> = {},
  opts: { replaced?: string[]; fileOps?: FileOpsExtractor | null } = {},
): PruneItem[] {
  return findPruneCandidates(
    { messages, replaced: new Set(opts.replaced) },
    {
      accessor,
      settings: { ...DEFAULT_COMPACTION_SETTINGS.micro, ...settings },
      fileOps: opts.fileOps === null ? undefined : (opts.fileOps ?? new FileOpsExtractor()),
    },
  );
}

const oaCandidates = (
  messages: OaMessage[],
  settings?: Partial<MicroSettings>,
  opts?: Parameters<typeof candidates>[3],
) => candidates(oaAccessor, messages, settings, opts);

const ids = (items: PruneItem[]) => items.map((item) => item.toolCallId);

/** Well over the default 1,000-token limit. */
const bigOutput = Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join("\n");

/** Under the limit, but larger than an eviction stub. */
const fileContents = Array.from({ length: 50 }, (_, i) => `export const value${i} = ${i};`).join(
  "\n",
);

const bashTurns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    oa.toolTurn(`c${i + 1}`, "bash", { command: "npm test" }, bigOutput),
  ).flat();

describe("findPruneCandidates", () => {
  it("protects the most recent keepRecentToolResults results", () => {
    const messages = [oa.user("run the tests a lot"), ...bashTurns(7)];

    expect(ids(oaCandidates(messages))).toEqual(["c1", "c2"]);
    expect(ids(oaCandidates(messages, { keepRecentToolResults: 0 }))).toHaveLength(7);
    expect(oaCandidates(messages, { keepRecentToolResults: 7 })).toEqual([]);
  });

  it("counts recency in tool results, not turns or messages", () => {
    const calls = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const messages = [
      an.user("check everything"),
      an.assistant(calls.map((id) => an.toolUse(id, "bash"))),
      an.user([...calls.map((id) => an.toolResult(id, bigOutput)), an.text("<reminder>")]),
    ];

    expect(ids(candidates(anAccessor, messages))).toEqual(["t1"]);
  });

  it("skips results that already have a replacement", () => {
    const messages = bashTurns(7);

    expect(ids(oaCandidates(messages, {}, { replaced: ["c1"] }))).toEqual(["c2"]);
  });

  it("leaves results within their limit alone", () => {
    const messages = oa.toolTurn("c1", "bash", { command: "ls" }, "a.ts\nb.ts");

    expect(oaCandidates(messages, { keepRecentToolResults: 0 })).toEqual([]);
  });

  it("reports the tokens of the original result and of its replacement", () => {
    const [item] = oaCandidates(bashTurns(1), { keepRecentToolResults: 0 });

    expect(item.tokensBefore).toBe(estimateText(bigOutput));
    expect(item.tokensAfter).toBe(estimateText(item.replacement));
    expect(item.tokensAfter).toBeLessThan(item.tokensBefore);
  });

  it("applies the first rule naming the tool over the global limits", () => {
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const messages = [
      ...oa.toolTurn("c1", "bash", { command: "ls" }, fiftyLines),
      ...oa.toolTurn("c2", "cat", { path: "huge.log" }, bigOutput),
      ...oa.toolTurn("c3", "grep", { pattern: "x" }, bigOutput),
    ];
    const rules = [
      { toolNames: ["bash"], maxToolResultTokens: 20, preserveHeadLines: 1, preserveTailLines: 1 },
      { toolNames: ["bash", "cat"], maxToolResultTokens: Infinity },
    ];

    const items = oaCandidates(messages, { keepRecentToolResults: 0, rules });

    expect(ids(items)).toEqual(["c1", "c3"]);
    expect(items[0].replacement).toBe(
      "line 0\n[... truncated 48 lines / 376 chars; original 50 lines ...]\nline 49",
    );
  });

  it("evicts reads superseded by a later successful read or modification of the same path", () => {
    const messages = [
      ...oa.toolTurn("r1", "read", { path: "a.ts" }, fileContents),
      ...oa.toolTurn("e1", "edit", { path: "a.ts" }, "ok"),
      ...oa.toolTurn("r2", "read", { path: "b.ts" }, fileContents),
      ...oa.toolTurn("e2", "edit", { path: "b.ts" }, "old_string not found", true),
      ...oa.toolTurn("r3", "read", { path: "c.ts" }, fileContents),
      ...oa.toolTurn("r4", "read", { path: "c.ts" }, fileContents),
      ...oa.toolTurn("r5", "read", { path: "d.ts" }, fileContents),
      oa.assistant(null, [oa.call("e3", "write", { path: "d.ts" })]), // aborted: no result
    ];

    const items = oaCandidates(messages, { keepRecentToolResults: 0 });

    expect(items.map((item) => [item.toolCallId, item.replacement])).toEqual([
      ["r1", evictionStub("a.ts", fileContents)],
      ["r3", evictionStub("c.ts", fileContents)],
    ]);
  });

  it("matches superseding calls on normalized paths", () => {
    const messages = [
      ...oa.toolTurn("r1", "read", { path: "./src\\a.ts" }, fileContents),
      ...oa.toolTurn("e1", "edit", { file_path: "src/a.ts" }, "ok"),
    ];

    expect(oaCandidates(messages, { keepRecentToolResults: 0 })).toEqual([
      expect.objectContaining({
        toolCallId: "r1",
        replacement: evictionStub("src/a.ts", fileContents),
      }),
    ]);
  });

  it("skips superseded-read detection when disabled or without a FileOpsExtractor", () => {
    const messages = [
      ...oa.toolTurn("r1", "read", { path: "a.ts" }, fileContents),
      ...oa.toolTurn("e1", "edit", { path: "a.ts" }, "ok"),
    ];

    expect(oaCandidates(messages, { keepRecentToolResults: 0, supersededReads: false })).toEqual(
      [],
    );
    expect(oaCandidates(messages, { keepRecentToolResults: 0 }, { fileOps: null })).toEqual([]);
  });

  it("skips a replacement that would not save tokens", () => {
    const messages = [
      ...oa.toolTurn("r1", "read", { path: "a.ts" }, "x"),
      ...oa.toolTurn("e1", "edit", { path: "a.ts" }, "ok"),
    ];

    expect(oaCandidates(messages, { keepRecentToolResults: 0 })).toEqual([]);
  });

  it("drops images from old results and counts them in tokensBefore", () => {
    const messages = oa.toolTurn("c1", "screenshot", {}, [oa.text("login page"), oa.image()]);

    expect(oaCandidates(messages, { keepRecentToolResults: 0 })).toEqual([
      {
        toolCallId: "c1",
        replacement: "login page\n[1 image(s) removed]",
        tokensBefore: estimateText("login page") + 1200,
        tokensAfter: estimateText("login page\n[1 image(s) removed]"),
      },
    ]);
  });
});
