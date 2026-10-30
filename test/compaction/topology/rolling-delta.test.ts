import { describe, expect, it, vi } from "vitest";
import { FileOpsExtractor } from "../../../src/compaction/extractors/file-ops.js";
import { ExtractorRegistry } from "../../../src/compaction/extractors/registry.js";
import { buildUpdatePrompt } from "../../../src/compaction/macro/prompts.js";
import { MacroSummarizer } from "../../../src/compaction/macro/summarizer.js";
import { estimateMessage, estimateText } from "../../../src/compaction/tokens.js";
import { RollingDeltaCompactor } from "../../../src/compaction/topology/rolling-delta.js";
import type { CompactOptions } from "../../../src/compaction/topology/types.js";
import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  type SessionEntry,
  type SummarizerFn,
} from "../../../src/compaction/types.js";
import {
  buildPath,
  compaction,
  message,
  type NewSessionEntry,
  prune,
} from "../../fixtures/entries.js";
import { type OaMessage, oa, oaAccessor } from "../../fixtures/openai-like.js";
import { fakeSummarizer, historySummary, isTurnPrefixPrompt } from "../../fixtures/summarizer.js";

const estimate = (msg: OaMessage) => estimateMessage(msg, oaAccessor);

function setup(
  settings: Partial<CompactionSettings> = {},
  summarize: SummarizerFn = fakeSummarizer(),
  label: string | null = "fake/model",
) {
  const full = { ...DEFAULT_COMPACTION_SETTINGS, ...settings };
  const extractors = new ExtractorRegistry([new FileOpsExtractor()]);
  const ctx = {
    accessor: oaAccessor,
    extractors,
    summarizer: new MacroSummarizer(summarize, oaAccessor, full),
    settings: full,
    estimate,
    summarizerLabel: label ?? undefined,
  };
  const compactor = new RollingDeltaCompactor<OaMessage>();
  const compact = (path: SessionEntry<OaMessage>[], opts: Partial<CompactOptions> = {}) =>
    compactor.compact(path, ctx, { reason: "threshold", tokensBefore: 5000, ...opts });
  return { compact, summarize: vi.mocked(summarize) };
}

// Every message below is 200 tokens: its label padded to 800 characters.
const pad = (label: string) => label.padEnd(800, ".");
const user = (label: string) => message(oa.user(pad(label)));
const reply = (label: string) => message(oa.assistant(pad(label)));
const path = (...entries: NewSessionEntry<OaMessage>[]) => buildPath(entries);

const prompts = (summarize: ReturnType<typeof setup>["summarize"]) =>
  summarize.mock.calls.map(([request]) => request.prompt);

async function compacted(result: ReturnType<ReturnType<typeof setup>["compact"]>) {
  const outcome = await result;
  if (outcome.status !== "compacted")
    throw new Error(`expected a compaction, got ${outcome.status}`);
  return outcome.entry;
}

describe("RollingDeltaCompactor", () => {
  it("returns nothing_to_compact when everything fits in the kept window", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 10_000 });

    expect(await compact(path(user("u0"), reply("a0")))).toEqual({ status: "nothing_to_compact" });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes the history before a clean cut and records the compaction", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 700 });
    const p = path(user("u0"), reply("a0"), user("u1"), reply("a1"), user("u2"), reply("a2"));

    const entry = await compacted(compact(p));

    // 700 tokens are reached at u1 (e2), a turn start: e0–e1 are summarized.
    const [prompt] = prompts(summarize);
    expect(prompt).toContain("[User]: u0");
    expect(prompt).toContain("[Assistant]: a0");
    expect(prompt).not.toContain("u1");
    expect(entry).toEqual({
      type: "compaction",
      summary: historySummary("Summary 1"),
      firstKeptEntryId: "e2",
      tokensBefore: 5000,
      tokensAfter: estimateText(historySummary("Summary 1")) + 4 * 200,
      details: { file_operations: { readFiles: [], modifiedFiles: [] } },
      reason: "threshold",
      promptVersion: "1",
      summarizerLabel: "fake/model",
    });
  });

  it("tracks file operations of summarized calls and renders them only in tokensAfter", async () => {
    const { compact } = setup({ keepRecentTokens: 700 });
    const p = path(
      user("u0"),
      message(oa.assistant(null, [oa.call("r1", "read", { path: "a.ts" })])),
      message(oa.tool("r1", pad("contents of a.ts"))),
      message(oa.assistant(null, [oa.call("e1", "edit", { path: "b.ts" })])),
      message(oa.tool("e1", "old_string not found", true)),
      user("u1"),
      reply("a1"),
      user("u2"),
      reply("a2"),
    );

    const entry = await compacted(compact(p));

    expect(entry.details).toEqual({ file_operations: { readFiles: ["a.ts"], modifiedFiles: [] } });
    expect(entry.summary).toBe(historySummary("Summary 1"));
    const rendered = `${historySummary("Summary 1")}\n\n<read-files>\na.ts\n</read-files>`;
    expect(entry.tokensAfter).toBe(estimateText(rendered) + 4 * 200);
  });

  it("summarizes the previous compaction's kept messages in the next compaction", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 700 });
    const previous = historySummary("Previous");
    const p = path(
      user("u0"), // e0: in the previous summary
      reply("a0"), // e1
      user("u1"), // e2: first kept by the previous compaction
      reply("a1"), // e3
      compaction("e2", {
        summary: previous,
        details: { file_operations: { readFiles: ["old.ts"], modifiedFiles: [] } },
      }),
      user("u2"), // e5
      reply("a2"),
      user("u3"),
      reply("a3"),
    );

    const entry = await compacted(compact(p));

    const transcript = `[User]: ${pad("u1")}\n\n[Assistant]: ${pad("a1")}`;
    expect(prompts(summarize)).toEqual([buildUpdatePrompt(previous, transcript)]);
    expect(entry.firstKeptEntryId).toBe("e5");
    expect(entry.details).toEqual({
      file_operations: { readFiles: ["old.ts"], modifiedFiles: [] },
    });
  });

  it("summarizes the prefix of a split turn separately", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 500 });
    const p = path(user("u0"), reply("a0"), user("u1"), reply("a1"), reply("a2"), reply("a3"));

    const entry = await compacted(compact(p));

    // 500 tokens are reached at a1 (e3), inside the turn that u1 (e2) started.
    const [history, prefix] = prompts(summarize);
    expect(history).toContain("[User]: u0");
    expect(history).not.toContain("u1");
    expect(prefix).toContain("[User]: u1");
    expect(entry.firstKeptEntryId).toBe("e3");
    expect(entry.summary).toContain("**Turn Context (split turn):**");
  });

  it("folds a turn prefix too large for one summarizer call into the history", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 500, maxSummarizerInputTokens: 150 });
    const p = path(user("u0"), reply("a0"), user("u1"), reply("a1"), reply("a2"), reply("a3"));

    const entry = await compacted(compact(p));

    expect(summarize.mock.calls.some(([request]) => isTurnPrefixPrompt(request))).toBe(false);
    expect(prompts(summarize).join("\n")).toContain("[User]: u1");
    expect(entry.summary).not.toContain("Turn Context");
    expect(entry.firstKeptEntryId).toBe("e3");
  });

  it("summarizes a turn that began before the boundary as ordinary history", async () => {
    const { compact, summarize } = setup({ keepRecentTokens: 300 });
    const p = path(
      user("u0"),
      reply("a0"),
      reply("a1"), // e2: first kept, mid-turn
      compaction("e2", { summary: historySummary("Previous") }),
      reply("a2"),
      reply("a3"),
      reply("a4"),
    );

    const entry = await compacted(compact(p));

    expect(summarize).toHaveBeenCalledOnce();
    expect(prompts(summarize)[0]).toContain("[Assistant]: a1");
    expect(entry.summary).not.toContain("Turn Context");
    expect(entry.firstKeptEntryId).toBe("e5");
  });

  it("measures pruned results at their replacement size but summarizes the raw result", async () => {
    const huge = "log ".repeat(10_000); // 10,000 tokens raw, a few once pruned
    const entries = [
      user("u0"),
      message(oa.assistant(null, [oa.call("c1", "bash", { command: "npm test" })])),
      message(oa.tool("c1", huge)),
      prune([{ toolCallId: "c1", replacement: "[cut]", tokensBefore: 10_000, tokensAfter: 2 }]),
      user("u1"),
      reply("a1"),
    ];

    // Counted raw, the 10,000-token result alone would fill a 500-token window.
    expect(await setup({ keepRecentTokens: 500 }).compact(path(...entries))).toEqual({
      status: "nothing_to_compact",
    });

    const { compact, summarize } = setup({ keepRecentTokens: 300 });
    await compacted(compact(path(...entries)));
    expect(prompts(summarize)[0]).toContain("[Tool result: bash]: log log");
    expect(prompts(summarize)[0]).not.toContain("[cut]");
  });

  it("uses keepRecentTokens from the options over the setting", async () => {
    const { compact } = setup({ keepRecentTokens: 10_000 });
    const p = path(user("u0"), reply("a0"), user("u1"), reply("a1"));

    const entry = await compacted(compact(p, { keepRecentTokens: 300, reason: "overflow" }));

    expect(entry.firstKeptEntryId).toBe("e2");
    expect(entry.reason).toBe("overflow");
  });

  it("omits summarizerLabel when the host gave none", async () => {
    const { compact } = setup({ keepRecentTokens: 300 }, fakeSummarizer(), null);

    const entry = await compacted(compact(path(user("u0"), reply("a0"), user("u1"), reply("a1"))));

    expect("summarizerLabel" in entry).toBe(false);
  });

  it("throws summary_not_smaller when the summary is not smaller than what it replaces", async () => {
    const bloated = vi.fn(async () => historySummary("x".repeat(10_000)));
    const { compact } = setup({ keepRecentTokens: 300 }, bloated);

    await expect(
      compact(path(user("u0"), reply("a0"), user("u1"), reply("a1"))),
    ).rejects.toMatchObject({ code: "summary_not_smaller" });
  });

  it("throws missing_kept_entry when the previous compaction's kept entry is not on the path", async () => {
    const { compact } = setup({ keepRecentTokens: 300 });

    await expect(compact(path(user("u0"), compaction("gone"), user("u1")))).rejects.toMatchObject({
      code: "missing_kept_entry",
    });
  });

  it("rejects with aborted and produces no entry when the signal aborts", async () => {
    const { compact } = setup({ keepRecentTokens: 300 });

    await expect(
      compact(path(user("u0"), reply("a0"), user("u1"), reply("a1")), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
