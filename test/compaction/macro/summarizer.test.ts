import { describe, expect, it, vi } from "vitest";
import {
  buildInitialPrompt,
  buildTurnPrefixPrompt,
  buildUpdatePrompt,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "../../../src/compaction/macro/prompts.js";
import { serializeConversation } from "../../../src/compaction/macro/serializer.js";
import { MacroSummarizer } from "../../../src/compaction/macro/summarizer.js";
import {
  type CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  type SummarizeRequest,
  type SummarizerFn,
} from "../../../src/compaction/types.js";
import { type OaMessage, oa, oaAccessor } from "../../fixtures/openai-like.js";
import { fakeSummarizer, historySummary, prefixSummary } from "../../fixtures/summarizer.js";

function setup(
  summarize: SummarizerFn = fakeSummarizer(),
  settings: Partial<CompactionSettings> = {},
) {
  const summarizer = new MacroSummarizer(summarize, oaAccessor, {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...settings,
  });
  return { summarize: vi.mocked(summarize), summarizer };
}

const transcript = (messages: OaMessage[]) =>
  serializeConversation(messages, oaAccessor, { maxToolResultChars: 2000 });
const prompts = (summarize: ReturnType<typeof setup>["summarize"]) =>
  summarize.mock.calls.map(([request]) => request.prompt);

const history = [oa.user("Fix the login bug."), oa.assistant("Looking at auth.ts.")];
const turnPrefix = [oa.user("Now add tests."), oa.assistant("Writing tests.")];

/** Fails `count` times with `output`, then returns a valid history summary. */
function flaky(output: string, count: number): SummarizerFn {
  let calls = 0;
  return vi.fn(async () => (calls++ < count ? output : historySummary()));
}

describe("MacroSummarizer", () => {
  it("summarizes history with the initial prompt, the system prompt, and summaryMaxTokens", async () => {
    const { summarize, summarizer } = setup();

    const summary = await summarizer.run({ history, turnPrefix: [] });

    expect(summary).toBe(historySummary("Summary 1"));
    expect(summarize).toHaveBeenCalledExactlyOnceWith({
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      prompt: buildInitialPrompt(transcript(history)),
      maxTokens: 8192,
      signal: undefined,
    });
  });

  it("updates the previous summary with the new messages", async () => {
    const { summarize, summarizer } = setup();

    await summarizer.run({ history, turnPrefix: [], previousSummary: "PREVIOUS" });

    expect(prompts(summarize)).toEqual([buildUpdatePrompt("PREVIOUS", transcript(history))]);
  });

  it("returns the previous summary unchanged when there is no history", async () => {
    const { summarize, summarizer } = setup();

    expect(await summarizer.run({ history: [], turnPrefix: [], previousSummary: "PREV" })).toBe(
      "PREV",
    );
    expect(summarize).not.toHaveBeenCalled();
  });

  it("folds a history larger than maxSummarizerInputTokens chunk by chunk", async () => {
    // A 40-character limit fits one 38-character block per chunk.
    const { summarize, summarizer } = setup(fakeSummarizer(), { maxSummarizerInputTokens: 10 });
    const messages = [oa.user("a".repeat(30)), oa.user("b".repeat(30)), oa.user("c".repeat(30))];

    const summary = await summarizer.run({ history: messages, turnPrefix: [] });

    expect(prompts(summarize)).toEqual([
      buildInitialPrompt(transcript([messages[0]])),
      buildUpdatePrompt(historySummary("Summary 1"), transcript([messages[1]])),
      buildUpdatePrompt(historySummary("Summary 2"), transcript([messages[2]])),
    ]);
    expect(summary).toBe(historySummary("Summary 3"));
  });

  it("keeps a message larger than the chunk size whole", async () => {
    const { summarize, summarizer } = setup(fakeSummarizer(), { maxSummarizerInputTokens: 10 });

    await summarizer.run({ history: [oa.user("x".repeat(1000))], turnPrefix: [] });

    expect(summarize).toHaveBeenCalledOnce();
  });

  it("summarizes a split turn's prefix separately and appends it as turn context", async () => {
    const { summarize, summarizer } = setup();

    const summary = await summarizer.run({ history, turnPrefix });

    expect(prompts(summarize)).toEqual([
      buildInitialPrompt(transcript(history)),
      buildTurnPrefixPrompt(transcript(turnPrefix)),
    ]);
    expect(summary).toBe(
      `${historySummary("Summary 1")}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary("Request 2")}`,
    );
  });

  it("returns only the turn context when there is no history or previous summary", async () => {
    const { summarizer } = setup();

    expect(await summarizer.run({ history: [], turnPrefix })).toBe(
      `**Turn Context (split turn):**\n\n${prefixSummary("Request 1")}`,
    );
  });

  it("keeps the previous summary when only a turn prefix is summarized", async () => {
    const { summarizer } = setup();

    expect(await summarizer.run({ history: [], turnPrefix, previousSummary: "PREV" })).toBe(
      `PREV\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary("Request 1")}`,
    );
  });

  it("retries an invalid summary once with the same request", async () => {
    const { summarize, summarizer } = setup(flaky("## Goal\nOnly a goal.", 1));

    expect(await summarizer.run({ history, turnPrefix: [] })).toBe(historySummary());
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0]).toEqual(summarize.mock.calls[1]);
  });

  it("fails with invalid_summary after a second invalid or empty summary", async () => {
    for (const output of ["## Goal\nOnly a goal.", "", "   "]) {
      const { summarize, summarizer } = setup(flaky(output, 2));

      await expect(summarizer.run({ history, turnPrefix: [] })).rejects.toMatchObject({
        code: "invalid_summary",
      });
      expect(summarize).toHaveBeenCalledTimes(2);
    }
  });

  it("validates turn-prefix summaries against the prefix headings", async () => {
    let prefixCalls = 0;
    const summarize = vi.fn(async (request: SummarizeRequest) => {
      if (!request.prompt.startsWith("<conversation>\n[User]: Now add tests.")) {
        return historySummary();
      }
      return prefixCalls++ === 0 ? "## Original Request\nTests." : prefixSummary();
    });
    const { summarizer } = setup(summarize);

    await summarizer.run({ history, turnPrefix });

    expect(prefixCalls).toBe(2);
  });

  it("trims surrounding whitespace from the summary", async () => {
    const { summarizer } = setup(vi.fn(async () => `\n\n${historySummary()}\n\n`));

    expect(await summarizer.run({ history, turnPrefix: [] })).toBe(historySummary());
  });

  describe("abort", () => {
    it("rejects with aborted, without calling the summarizer, when already aborted", async () => {
      const { summarize, summarizer } = setup();
      const signal = AbortSignal.abort("user cancelled");

      await expect(summarizer.run({ history, turnPrefix: [], signal })).rejects.toMatchObject({
        code: "aborted",
        cause: "user cancelled",
      });
      expect(summarize).not.toHaveBeenCalled();
    });

    it("passes the signal to the summarizer and wraps its rejection after an abort", async () => {
      const controller = new AbortController();
      const upstream = new Error("request aborted");
      const summarize = vi.fn(async () => {
        controller.abort();
        throw upstream;
      });
      const { summarizer } = setup(summarize);

      await expect(
        summarizer.run({ history, turnPrefix: [], signal: controller.signal }),
      ).rejects.toMatchObject({ code: "aborted", cause: upstream });
      expect(summarize.mock.calls[0]).toEqual([
        expect.objectContaining({ signal: controller.signal }),
      ]);
    });

    it("rejects with aborted when the summarizer ignores the abort and returns", async () => {
      const controller = new AbortController();
      const summarize = vi.fn(async () => {
        controller.abort();
        return historySummary();
      });
      const { summarizer } = setup(summarize);

      await expect(
        summarizer.run({ history, turnPrefix: [], signal: controller.signal }),
      ).rejects.toMatchObject({ code: "aborted" });
    });
  });

  it("passes other summarizer errors through unchanged", async () => {
    const failure = new Error("rate limited");
    const { summarizer } = setup(
      vi.fn(async () => {
        throw failure;
      }),
    );

    await expect(summarizer.run({ history, turnPrefix: [] })).rejects.toBe(failure);
  });
});
