import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_TOKENS,
  estimateMessage,
  estimateText,
  measureContext,
} from "../../src/compaction/tokens.js";
import { isMessageEntry, type SessionEntry } from "../../src/compaction/types.js";
import { an, anAccessor } from "../fixtures/anthropic-like.js";
import {
  buildPath,
  compaction,
  message,
  type NewSessionEntry,
  prune,
} from "../fixtures/entries.js";
import { type OaMessage, oa, oaAccessor } from "../fixtures/openai-like.js";

const chars = (n: number, c = "x") => c.repeat(n);

describe("estimateText", () => {
  it("rounds characters / 4 up", () => {
    expect(estimateText("")).toBe(0);
    expect(estimateText("abcd")).toBe(1);
    expect(estimateText("abcde")).toBe(2);
  });
});

describe("estimateMessage", () => {
  it("counts model-visible text", () => {
    expect(estimateMessage(oa.user(chars(10)), oaAccessor)).toBe(3);
  });

  it("counts tool call names with their raw argument strings", () => {
    const msg = oa.assistant("Reading.", [oa.call("c1", "read", { path: "src/a.ts" })]);

    expect(estimateMessage(msg, oaAccessor)).toBe(
      Math.ceil(`Reading.read{"path":"src/a.ts"}`.length / 4),
    );
  });

  it("JSON-encodes arguments when there is no raw form", () => {
    const msg = an.assistant([an.toolUse("t1", "read", { path: "a.ts" })]);

    expect(estimateMessage(msg, anAccessor)).toBe(Math.ceil(`read{"path":"a.ts"}`.length / 4));
  });

  it("counts {} for unparsable arguments without a raw form", () => {
    const accessor = {
      ...oaAccessor,
      getToolCalls: () => [{ id: "c1", name: "read", arguments: undefined }],
    };

    expect(estimateMessage(oa.assistant(null), accessor)).toBe(Math.ceil("read{}".length / 4));
  });

  it("counts result text plus a fixed cost per image", () => {
    const msg = an.user([
      an.toolResult("t1", [an.text(chars(40)), an.image(), an.image()]),
      an.text("note"),
    ]);
    const textTokens = Math.ceil((40 + "note".length) / 4);

    expect(estimateMessage(msg, anAccessor)).toBe(textTokens + 2 * DEFAULT_IMAGE_TOKENS);
    expect(estimateMessage(msg, anAccessor, 500)).toBe(textTokens + 2 * 500);
  });

  it("does not count opaque content", () => {
    const msg = an.assistant([an.thinking(chars(400)), an.text("ok")]);

    expect(estimateMessage(msg, anAccessor)).toBe(1);
  });

  it("uses the accessor's estimateTokens override when present", () => {
    const accessor = { ...oaAccessor, estimateTokens: () => 42 };

    expect(estimateMessage(oa.user(chars(1000)), accessor)).toBe(42);
  });
});

describe("measureContext", () => {
  const estimate = (msg: OaMessage) => estimateMessage(msg, oaAccessor);
  const allMessages = (path: SessionEntry<OaMessage>[]) =>
    path.filter((e) => isMessageEntry(e)).map((e) => e.message);
  const usage = (prompt: number, completion: number) => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
  });

  function setup(
    entries: NewSessionEntry<OaMessage>[],
    build: (path: SessionEntry<OaMessage>[]) => OaMessage[] = allMessages,
  ) {
    const path = buildPath(entries);
    const buildContext = vi.fn(build);
    const measure = (overheadTokens?: number) =>
      measureContext(
        path,
        { contextWindow: 200_000, overheadTokens },
        { accessor: oaAccessor, estimate, buildContext },
      );
    return { path, buildContext, measure };
  }

  it("estimates the built context plus overhead when no message has usage", () => {
    const { path, buildContext, measure } = setup([
      message(oa.user(chars(400))),
      message(oa.assistant(chars(200))),
    ]);

    expect(measure(3000)).toBe(100 + 50 + 3000);
    expect(measure()).toBe(100 + 50);
    expect(buildContext).toHaveBeenCalledWith(path);
  });

  it("anchors on the latest usage and estimates only the messages after it", () => {
    const { buildContext, measure } = setup([
      message(oa.user(chars(400))),
      message(oa.assistant("ok", [], usage(1000, 20))),
      message(oa.user(chars(80))),
      message(oa.assistant("done", [], usage(5000, 40))),
      message(oa.user(chars(40))),
      message(oa.harness(chars(4))),
    ]);

    expect(measure()).toBe(5000 + 40 + 10 + 1);
    expect(measure(3000)).toBe(5000 + 40 + 10 + 1); // overhead is already inside usage
    expect(buildContext).not.toHaveBeenCalled();
  });

  it("subtracts savings of prunes appended after the anchor, but not of earlier prunes", () => {
    const { measure } = setup([
      message(oa.user("go")),
      message(oa.assistant(null, [oa.call("c0", "bash"), oa.call("c1", "read")])),
      message(oa.tool("c0", chars(2000))),
      message(oa.tool("c1", chars(4000))),
      prune([{ toolCallId: "c0", replacement: "[cut]", tokensBefore: 500, tokensAfter: 5 }]),
      message(oa.assistant("done", [], usage(2000, 10))),
      prune([{ toolCallId: "c1", replacement: "[cut]", tokensBefore: 1000, tokensAfter: 10 }]),
      message(oa.user(chars(40))),
    ]);

    expect(measure()).toBe(2000 + 10 - (1000 - 10) + 10);
  });

  it("counts a result appended after the anchor at its pruned size", () => {
    const { measure } = setup([
      message(oa.user("go")),
      message(oa.assistant(null, [oa.call("c1", "read")], usage(1000, 30))),
      message(oa.tool("c1", chars(4000))),
      prune([{ toolCallId: "c1", replacement: "[cut]", tokensBefore: 1000, tokensAfter: 10 }]),
    ]);

    expect(measure()).toBe(1000 + 30 + 1000 - (1000 - 10));
  });

  it("falls back to the built context when a compaction follows the latest usage", () => {
    const built = [
      oaAccessor.createSummaryMessage(chars(400, "s")),
      oa.user(chars(40, "b")),
      oa.user(chars(40, "c")),
    ];
    const { buildContext, measure } = setup(
      [
        message(oa.user(chars(400, "a"))),
        message(oa.assistant("ok", [], usage(50_000, 100))),
        message(oa.user(chars(40, "b"))),
        compaction("e2"),
        message(oa.user(chars(40, "c"))),
      ],
      () => built,
    );

    expect(measure(3000)).toBe(100 + 10 + 10 + 3000);
    expect(buildContext).toHaveBeenCalledOnce();
  });

  it("anchors on usage reported after a compaction", () => {
    const { buildContext, measure } = setup([
      message(oa.user(chars(400))),
      message(oa.assistant("ok", [], usage(50_000, 100))),
      compaction("e1"),
      message(oa.user(chars(40))),
      message(oa.assistant("ok", [], usage(8000, 50))),
      message(oa.user(chars(40))),
    ]);

    expect(measure(3000)).toBe(8000 + 50 + 10);
    expect(buildContext).not.toHaveBeenCalled();
  });

  it("ignores entry types it does not know", () => {
    const { measure } = setup([
      message(oa.user(chars(40))),
      message(oa.assistant("ok", [], usage(1000, 10))),
      { type: "label", label: "checkpoint" },
      message(oa.user(chars(40))),
    ]);

    expect(measure()).toBe(1000 + 10 + 10);
  });
});
