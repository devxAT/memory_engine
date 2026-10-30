import { describe, expect, it } from "vitest";
import { pairToolCalls } from "../../src/compaction/groups.js";
import { an, anAccessor } from "../fixtures/anthropic-like.js";
import { oa, oaAccessor } from "../fixtures/openai-like.js";

const T = true;
const F = false;

describe("pairToolCalls", () => {
  it("blocks cuts between a call and its result", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        oa.user("read a.ts"),
        oa.assistant(null, [oa.call("c1", "read", { path: "a.ts" })]),
        oa.tool("c1", "contents"),
        oa.assistant("done"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, F, T]);
    expect(resultIndex).toEqual(new Map([["c1", 2]]));
  });

  it("keeps parallel calls and their separate result messages together", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        oa.user("look around"),
        oa.assistant(null, [oa.call("c1", "ls"), oa.call("c2", "pwd"), oa.call("c3", "env")]),
        oa.tool("c1", "a b"),
        oa.tool("c2", "/repo"),
        oa.tool("c3", "PATH=…"),
        oa.assistant("done"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, F, F, F, T]);
    expect(resultIndex).toEqual(
      new Map([
        ["c1", 2],
        ["c2", 3],
        ["c3", 4],
      ]),
    );
  });

  it("pairs parallel results carried in one user message", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        an.user("look around"),
        an.assistant([an.toolUse("t1", "ls"), an.toolUse("t2", "pwd")]),
        an.user([
          an.toolResult("t1", "a b"),
          an.toolResult("t2", "/repo"),
          an.text("<system-reminder>…</system-reminder>"),
        ]),
        an.assistant("done"),
      ],
      anAccessor,
    );

    expect(validCut).toEqual([T, T, F, T]);
    expect(resultIndex).toEqual(
      new Map([
        ["t1", 2],
        ["t2", 2],
      ]),
    );
  });

  it("blocks cuts at harness messages injected between results", () => {
    const { validCut } = pairToolCalls(
      [
        oa.user("go"),
        oa.assistant(null, [oa.call("c1", "ls"), oa.call("c2", "pwd")]),
        oa.tool("c1", "a b"),
        oa.harness("reminder"),
        oa.tool("c2", "/repo"),
        oa.assistant("done"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, F, F, F, T]);
  });

  it("covers the full span of overlapping calls", () => {
    const { validCut } = pairToolCalls(
      [
        oa.user("go"),
        oa.assistant(null, [oa.call("long", "build")]),
        oa.harness("build started"),
        oa.assistant(null, [oa.call("short", "ls")]),
        oa.tool("short", "a b"),
        oa.tool("long", "built"),
        oa.assistant("done"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, F, F, F, F, T]);
  });

  it("lets aborted calls without a result leave cuts open", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        oa.user("go"),
        oa.assistant(null, [oa.call("c1", "bash", { command: "sleep 600" })]),
        oa.user("stop, do something else"),
        oa.assistant("ok"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, T, T]);
    expect(resultIndex.size).toBe(0);
  });

  it("lets orphan results, and results before their call, leave cuts open", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        oa.tool("early", "result first"),
        oa.assistant(null, [oa.call("early", "ls")]),
        oa.tool("ghost", "no call"),
        oa.assistant("done"),
      ],
      oaAccessor,
    );

    expect(validCut).toEqual([T, T, T, T]);
    expect(resultIndex).toEqual(
      new Map([
        ["early", 0],
        ["ghost", 2],
      ]),
    );
  });

  it("adds no constraint for server-side calls answered in the same message", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [
        an.user("search"),
        an.assistant([
          an.serverToolUse("s1", "web_search", { query: "vitest" }),
          an.webSearchResult("s1", [{ title: "Vitest", url: "https://vitest.dev" }]),
          an.text("Found it."),
        ]),
        an.user("thanks"),
      ],
      anAccessor,
    );

    expect(validCut).toEqual([T, T, T]);
    expect(resultIndex).toEqual(new Map([["s1", 1]]));
  });

  it("uses the first result when an ID repeats", () => {
    const { resultIndex, validCut } = pairToolCalls(
      [oa.assistant(null, [oa.call("c1", "ls")]), oa.tool("c1", "first"), oa.tool("c1", "second")],
      oaAccessor,
    );

    expect(resultIndex).toEqual(new Map([["c1", 1]]));
    expect(validCut).toEqual([T, F, T]);
  });

  it("handles an empty conversation", () => {
    expect(pairToolCalls([], oaAccessor)).toEqual({ resultIndex: new Map(), validCut: [] });
  });
});
