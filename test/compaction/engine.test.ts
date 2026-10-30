import { describe, expect, it, vi } from "vitest";
import {
  CompactionEngine,
  type CompactionEngineDeps,
  resolveSettings,
} from "../../src/compaction/engine.js";
import { FileOpsExtractor } from "../../src/compaction/extractors/file-ops.js";
import { evictionStub } from "../../src/compaction/micro/pruner.js";
import { estimateMessage } from "../../src/compaction/tokens.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  isCompactionEntry,
  isPruneEntry,
  type ModelBudget,
} from "../../src/compaction/types.js";
import { buildPath, compaction, message, type NewSessionEntry } from "../fixtures/entries.js";
import { type OaMessage, oa, oaAccessor } from "../fixtures/openai-like.js";
import { fakeSummarizer, isTurnPrefixPrompt } from "../fixtures/summarizer.js";

function engine(deps: Partial<CompactionEngineDeps<OaMessage>> = {}) {
  return new CompactionEngine<OaMessage>({
    accessor: oaAccessor,
    summarize: fakeSummarizer(),
    ...deps,
  });
}

/** An append-only in-memory session. */
function session(entries: NewSessionEntry<OaMessage>[] = []) {
  return {
    entries,
    append: (entry: NewSessionEntry<OaMessage>) => entries.push(entry),
    path: () => buildPath(entries),
  };
}
type Session = ReturnType<typeof session>;

class ContextOverflowError extends Error {}

/** The reference host loop from architecture/compaction.md §10. */
async function runModelRequest(
  s: Session,
  eng: CompactionEngine<OaMessage>,
  budget: ModelBudget,
  callModel: (context: OaMessage[]) => Promise<OaMessage>,
): Promise<OaMessage> {
  const prune = eng.planMicro(s.path(), budget);
  if (prune) s.append(prune);

  if (eng.shouldCompact(s.path(), budget)) {
    const outcome = await eng.compact(s.path(), budget, { reason: "threshold" });
    if (outcome.status === "compacted") s.append(outcome.entry);
  }

  try {
    return await callModel(eng.buildContext(s.path()));
  } catch (err) {
    if (!(err instanceof ContextOverflowError)) throw err;
    const outcome = await eng.compact(s.path(), budget, { reason: "overflow" });
    if (outcome.status !== "compacted") throw err;
    s.append(outcome.entry);
    return await callModel(eng.buildContext(s.path())); // single retry
  }
}

const estimate = (msg: OaMessage) => estimateMessage(msg, oaAccessor);
const contextTokens = (context: OaMessage[]) => context.reduce((n, m) => n + estimate(m), 0);
const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
});

/** `label` padded to `tokens` tokens. */
const pad = (label: string, tokens = 200) => label.padEnd(tokens * 4, ".");
const turns = (count: number) =>
  Array.from({ length: count }, (_, i) => [
    message(oa.user(pad(`u${i}`))),
    message(oa.assistant(pad(`a${i}`))),
  ]).flat();

/** About 6,000 tokens. */
const bigOutput = Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join("\n");
const bashTurns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    oa.toolTurn(`c${i + 1}`, "bash", { command: "npm test" }, bigOutput).map(message),
  ).flat();

const ok = async (_context: OaMessage[]) => oa.assistant("ok");

describe("resolveSettings", () => {
  it("merges the input over the defaults, micro one level deep", () => {
    expect(resolveSettings({ keepRecentTokens: 5, micro: { keepRecentToolResults: 1 } })).toEqual({
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 5,
      micro: { ...DEFAULT_COMPACTION_SETTINGS.micro, keepRecentToolResults: 1 },
    });
  });

  it("shares nothing with the defaults", () => {
    const before = structuredClone(DEFAULT_COMPACTION_SETTINGS);
    const settings = resolveSettings();

    settings.reserveTokens = 1;
    settings.micro.maxLineChars = 1;
    settings.micro.rules.push({ toolNames: ["bash"] });

    expect(DEFAULT_COMPACTION_SETTINGS).toEqual(before);
  });
});

describe("CompactionEngine", () => {
  const budget = { contextWindow: 200_000 };

  it("builds the context with the registered extractors' blocks", () => {
    const path = buildPath([
      message(oa.user("old")),
      message(oa.user("kept")),
      compaction("e1", {
        summary: "S",
        details: { file_operations: { readFiles: ["a.ts"], modifiedFiles: [] } },
      }),
    ]);

    const [withBlocks] = engine().buildContext(path);
    const [withoutBlocks] = engine({ extractors: [] }).buildContext(path);

    expect(oaAccessor.toText(withBlocks)).toBe("S\n\n<read-files>\na.ts\n</read-files>");
    expect(oaAccessor.toText(withoutBlocks)).toBe("S");
  });

  it("measures from provider usage, or from the built context once a compaction follows it", () => {
    const withOverhead = { contextWindow: 200_000, overheadTokens: 500 };
    const anchored = buildPath([
      message(oa.user(pad("u0"))),
      message(oa.assistant("ok", [], usage(1000, 20))),
      message(oa.user(pad("u1", 10))),
    ]);
    const compacted = buildPath([
      message(oa.user(pad("u0"))),
      message(oa.assistant(pad("a0"), [], usage(5000, 200))),
      compaction("e1", { summary: "S" }),
      message(oa.user(pad("u1", 10))),
    ]);

    expect(engine().measure(anchored, withOverhead)).toBe(1000 + 20 + 10);
    // Summary "S" (1) + kept a0 (200) + u1 (10) + overhead.
    expect(engine().measure(compacted, withOverhead)).toBe(1 + 200 + 10 + 500);
  });

  it("triggers above contextWindow − reserveTokens, unless compaction is disabled", () => {
    const small = { contextWindow: 2000 };
    const at = (prompt: number) => buildPath([message(oa.assistant("ok", [], usage(prompt, 50)))]);
    const eng = engine({ settings: { reserveTokens: 1000 } });

    expect(eng.shouldCompact(at(950), small)).toBe(false); // 1,000 = threshold
    expect(eng.shouldCompact(at(1000), small)).toBe(true);
    expect(
      engine({ settings: { reserveTokens: 1000, enabled: false } }).shouldCompact(at(1000), small),
    ).toBe(false);
  });

  describe("planMicro", () => {
    it("prunes old tool results once, then has nothing left to prune", () => {
      const s = session(bashTurns(7));
      const eng = engine();

      const entry = eng.planMicro(s.path(), budget);
      expect(entry?.strategy).toBe("proactive");
      expect(entry?.items.map((item) => item.toolCallId)).toEqual(["c1", "c2"]);

      s.append(entry as NewSessionEntry<OaMessage>);
      expect(eng.planMicro(s.path(), budget)).toBeNull();
    });

    it("does nothing when compaction is disabled", () => {
      expect(
        engine({ settings: { enabled: false } }).planMicro(session(bashTurns(7)).path(), budget),
      ).toBeNull();
    });

    it("prunes reactively only above the threshold when configured", () => {
      const eng = engine({ settings: { micro: { strategy: "reactive" } } });
      const path = session(bashTurns(7)).path(); // about 42,000 tokens

      expect(eng.planMicro(path, { contextWindow: 100_000 })).toBeNull();
      expect(eng.planMicro(path, { contextWindow: 40_000 })?.strategy).toBe("reactive");
    });

    it("detects superseded reads with the registered FileOpsExtractor", () => {
      const contents = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const path = buildPath(
        [
          ...oa.toolTurn("r1", "cat", { path: "a.ts" }, contents),
          ...oa.toolTurn("e1", "edit", { path: "a.ts" }, "ok"),
        ].map(message),
      );
      const settings = { micro: { keepRecentToolResults: 0 } };

      const custom = engine({
        settings,
        extractors: [new FileOpsExtractor({ readTools: ["cat"] })],
      });
      expect(custom.planMicro(path, budget)?.items).toEqual([
        expect.objectContaining({ toolCallId: "r1", replacement: evictionStub("a.ts", contents) }),
      ]);
      expect(engine({ settings, extractors: [] }).planMicro(path, budget)).toBeNull();
    });
  });

  describe("compact", () => {
    it("defaults to a manual compaction and records tokensBefore and the summarizer label", async () => {
      const eng = engine({ settings: { keepRecentTokens: 300 }, summarizerLabel: "fake/model" });
      const path = session(turns(2)).path();

      const outcome = await eng.compact(path, budget);

      expect(outcome).toMatchObject({
        status: "compacted",
        entry: {
          reason: "manual",
          tokensBefore: eng.measure(path, budget),
          firstKeptEntryId: "e2",
          summarizerLabel: "fake/model",
        },
      });
    });

    it("keeps half of keepRecentTokens when recovering from an overflow", async () => {
      const eng = engine({ settings: { keepRecentTokens: 600 } });
      const path = session(turns(3)).path();

      const threshold = await eng.compact(path, budget, { reason: "threshold" });
      const overflow = await eng.compact(path, budget, { reason: "overflow" });

      // 600 tokens are reached at a1 (e3); 300 at u2 (e4).
      expect(threshold).toMatchObject({ entry: { firstKeptEntryId: "e3", reason: "threshold" } });
      expect(overflow).toMatchObject({ entry: { firstKeptEntryId: "e4", reason: "overflow" } });
    });

    it("returns nothing_to_compact when nothing can be summarized", async () => {
      expect(await engine().compact(session(turns(1)).path(), budget)).toEqual({
        status: "nothing_to_compact",
      });
    });
  });
});

describe("host loop", () => {
  it("runs micro-compaction first, so pruning can make a summary unnecessary", async () => {
    const summarize = fakeSummarizer();
    const eng = engine({ summarize, settings: { micro: { keepRecentToolResults: 2 } } });
    const s = session([message(oa.user("run the tests")), ...bashTurns(7)]);
    const callModel = vi.fn(ok);

    await runModelRequest(s, eng, { contextWindow: 40_000 }, callModel);

    expect(s.path().filter((e) => isPruneEntry(e))).toHaveLength(1);
    expect(s.path().some((e) => isCompactionEntry(e))).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(contextTokens(callModel.mock.calls[0][0])).toBeLessThan(40_000 - 16_384);
  });

  it("compacts when pruning is not enough", async () => {
    const summarize = fakeSummarizer();
    const eng = engine({ summarize, settings: { reserveTokens: 1000, keepRecentTokens: 1000 } });
    const s = session(turns(10)); // 4,000 tokens of text
    const callModel = vi.fn(ok);

    await runModelRequest(s, eng, { contextWindow: 3000 }, callModel);

    const [context] = callModel.mock.calls[0];
    expect(oaAccessor.toText(context[0])).toContain("## Goal");
    expect(contextTokens(context)).toBeLessThanOrEqual(2000);
    expect(s.entries.at(-1)).toMatchObject({ type: "compaction", reason: "threshold" });
  });

  it("recovers from a context overflow with one smaller compaction and a single retry", async () => {
    const eng = engine({ settings: { keepRecentTokens: 1000 } });
    const s = session(turns(10));
    const callModel = vi
      .fn<(context: OaMessage[]) => Promise<OaMessage>>()
      .mockRejectedValueOnce(new ContextOverflowError("prompt is too long"))
      .mockImplementation(ok);

    const reply = await runModelRequest(s, eng, { contextWindow: 200_000 }, callModel);

    expect(oaAccessor.toText(reply)).toBe("ok");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(s.entries.at(-1)).toMatchObject({ type: "compaction", reason: "overflow" });
    expect(contextTokens(callModel.mock.calls[1][0])).toBeLessThan(
      contextTokens(callModel.mock.calls[0][0]),
    );
  });

  it("surfaces a second overflow instead of looping", async () => {
    const s = session(turns(10));
    const callModel = vi.fn(async () => {
      throw new ContextOverflowError("prompt is too long");
    });

    const eng = engine({ settings: { keepRecentTokens: 1000 } });

    await expect(
      runModelRequest(s, eng, { contextWindow: 200_000 }, callModel),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(s.path().filter((e) => isCompactionEntry(e))).toHaveLength(1);
  });

  it("surfaces the overflow when there is nothing to compact", async () => {
    const s = session([message(oa.user("hello"))]);
    const callModel = vi.fn(async () => {
      throw new ContextOverflowError("prompt is too long");
    });

    await expect(
      runModelRequest(s, engine(), { contextWindow: 200_000 }, callModel),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(callModel).toHaveBeenCalledOnce();
    expect(s.entries).toHaveLength(1);
  });

  it("keeps a long session under the threshold across repeated compactions", async () => {
    const summarize = fakeSummarizer();
    const eng = engine({ summarize, settings: { reserveTokens: 500, keepRecentTokens: 1000 } });
    const budget = { contextWindow: 3000 };
    const s = session();
    const sent: number[] = [];

    for (let i = 0; i < 30; i++) {
      s.append(message(oa.user(pad(`u${i}`))));
      const reply = await runModelRequest(s, eng, budget, async (context) => {
        sent.push(contextTokens(context));
        return oa.assistant(pad(`a${i}`), [], usage(contextTokens(context), 200));
      });
      s.append(message(reply));
    }

    const compactions = s.path().filter((e) => isCompactionEntry(e));
    expect(compactions.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sent)).toBeLessThanOrEqual(budget.contextWindow - 500);
    // Every compaction after the first folds into the previous summary.
    const historyPrompts = summarize.mock.calls
      .filter(([request]) => !isTurnPrefixPrompt(request))
      .map(([request]) => request.prompt);
    expect(historyPrompts.slice(1).every((p) => p.startsWith("<previous-summary>"))).toBe(true);
  });
});
