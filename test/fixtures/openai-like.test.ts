import { describe, expect, it } from "vitest";
import { oa, oaAccessor } from "./openai-like.js";

describe("openai-like accessor", () => {
  it("maps roles to origins", () => {
    const msgs = [
      oa.system("rules"),
      oa.user("fix the bug"),
      oa.harness("reminder"),
      oa.assistant("ok"),
      oa.tool("c1", "done"),
    ];

    expect(msgs.map((m) => oaAccessor.getOrigin(m))).toEqual([
      "system",
      "human",
      "harness",
      "model",
      "tool",
    ]);
  });

  it("parses JSON-string arguments and keeps the raw form", () => {
    const msg = oa.assistant(null, [
      oa.call("c1", "read", { path: "src/a.ts" }),
      oa.call("c2", "bash", { command: "ls" }),
    ]);

    expect(oaAccessor.getToolCalls(msg)).toEqual([
      {
        id: "c1",
        name: "read",
        arguments: { path: "src/a.ts" },
        rawArguments: '{"path":"src/a.ts"}',
      },
      { id: "c2", name: "bash", arguments: { command: "ls" }, rawArguments: '{"command":"ls"}' },
    ]);
  });

  it("returns undefined arguments when they are not a JSON object", () => {
    const msg = oa.assistant(null, [
      oa.call("c1", "read", '{"path": "src/a'),
      oa.call("c2", "read", "[1,2]"),
    ]);

    expect(oaAccessor.getToolCalls(msg).map((c) => [c.arguments, c.rawArguments])).toEqual([
      [undefined, '{"path": "src/a'],
      [undefined, "[1,2]"],
    ]);
  });

  it("reads the single result of a tool message, counting images and errors", () => {
    const withImages = oa.tool("c1", [
      oa.text("line 1"),
      oa.image(),
      oa.text("line 2"),
      oa.image(),
    ]);

    expect(oaAccessor.getToolResults(withImages)).toEqual([
      { toolCallId: "c1", text: "line 1\nline 2", imageCount: 2, isError: false },
    ]);
    expect(oaAccessor.getToolResults(oa.tool("c2", "ENOENT", true))).toEqual([
      { toolCallId: "c2", text: "ENOENT", imageCount: 0, isError: true },
    ]);
    expect(oaAccessor.getToolResults(oa.user("hi"))).toEqual([]);
  });

  it("excludes tool calls and results from toText", () => {
    const withCall = oa.assistant("Reading.", [oa.call("c1", "read", { path: "a.ts" })]);

    expect(oaAccessor.toText(withCall)).toBe("Reading.");
    expect(oaAccessor.toText(oa.assistant(null, [oa.call("c1", "read")]))).toBe("");
    expect(oaAccessor.toText(oa.tool("c1", "file contents"))).toBe("");
  });

  it("replaces a result in a copy, dropping images, without mutating the original", () => {
    const original = oa.tool("c1", [oa.text("huge output"), oa.image()]);
    const snapshot = structuredClone(original);

    const replaced = oaAccessor.replaceToolResult(original, "c1", "[truncated]");

    expect(replaced).not.toBe(original);
    expect(original).toEqual(snapshot);
    expect(oaAccessor.getToolResults(replaced)).toEqual([
      { toolCallId: "c1", text: "[truncated]", imageCount: 0, isError: false },
    ]);
  });

  it("returns messages that do not hold the result unchanged", () => {
    const otherResult = oa.tool("c2", "out");
    const user = oa.user("hi");

    expect(oaAccessor.replaceToolResult(otherResult, "c1", "x")).toBe(otherResult);
    expect(oaAccessor.replaceToolResult(user, "c1", "x")).toBe(user);
  });

  it("creates a harness summary message carrying the rendered text", () => {
    const summary = oaAccessor.createSummaryMessage("## Goal\nShip it.");

    expect(oaAccessor.getOrigin(summary)).toBe("harness");
    expect(oaAccessor.toText(summary)).toBe("## Goal\nShip it.");
  });

  it("reads usage from assistant messages only", () => {
    const withUsage = oa.assistant("ok", [], { prompt_tokens: 1200, completion_tokens: 80 });

    expect(oaAccessor.getUsage?.(withUsage)).toEqual({ inputTokens: 1200, outputTokens: 80 });
    expect(oaAccessor.getUsage?.(oa.assistant("ok"))).toBeUndefined();
    expect(oaAccessor.getUsage?.(oa.user("hi"))).toBeUndefined();
  });
});
