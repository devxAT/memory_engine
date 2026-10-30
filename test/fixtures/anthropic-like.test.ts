import { describe, expect, it } from "vitest";
import { an, anAccessor } from "./anthropic-like.js";

describe("anthropic-like accessor", () => {
  it("derives origins from content, not only from the role", () => {
    const msgs = [
      an.user("fix the bug"),
      an.harness("<system-reminder>tests are slow</system-reminder>"),
      an.assistant([an.text("Reading."), an.toolUse("t1", "read", { path: "a.ts" })]),
      an.user([an.toolResult("t1", "contents"), an.text("<system-reminder>…</system-reminder>")]),
    ];

    expect(msgs.map((m) => anAccessor.getOrigin(m))).toEqual(["human", "harness", "model", "tool"]);
  });

  it("returns every result block of a user message, with the injected text as its text", () => {
    const msg = an.user([
      an.toolResult("t1", "a.ts contents"),
      an.toolResult("t2", [an.text("screenshot taken"), an.image()]),
      an.toolResult("t3", "command not found", true),
      an.text("<system-reminder>2 files changed</system-reminder>"),
    ]);

    expect(anAccessor.getToolResults(msg)).toEqual([
      { toolCallId: "t1", text: "a.ts contents", imageCount: 0, isError: false },
      { toolCallId: "t2", text: "screenshot taken", imageCount: 1, isError: false },
      { toolCallId: "t3", text: "command not found", imageCount: 0, isError: true },
    ]);
    expect(anAccessor.toText(msg)).toBe("<system-reminder>2 files changed</system-reminder>");
    expect(anAccessor.getToolCalls(msg)).toEqual([]);
  });

  it("returns a server-side call and its result from the same assistant message", () => {
    const msg = an.assistant([
      an.serverToolUse("s1", "web_search", { query: "vitest 5" }),
      an.webSearchResult("s1", [{ title: "Vitest 5", url: "https://vitest.dev" }]),
      an.text("Vitest 5 is out."),
    ]);

    expect(anAccessor.getOrigin(msg)).toBe("model");
    expect(anAccessor.getToolCalls(msg)).toEqual([
      { id: "s1", name: "web_search", arguments: { query: "vitest 5" } },
    ]);
    expect(anAccessor.getToolResults(msg)).toEqual([
      { toolCallId: "s1", text: "Vitest 5 https://vitest.dev", imageCount: 0, isError: false },
    ]);
    expect(anAccessor.toText(msg)).toBe("Vitest 5 is out.");
  });

  it("excludes thinking and tool blocks from toText", () => {
    const msg = an.assistant([
      an.thinking("private reasoning"),
      an.text("Plan:"),
      an.toolUse("t1", "read"),
      an.text("step 1"),
    ]);

    expect(anAccessor.toText(msg)).toBe("Plan:\nstep 1");
  });

  it("replaces only the matching result, dropping its images, without mutating the original", () => {
    const original = an.user([
      an.toolResult("t1", [an.text("big output"), an.image()]),
      an.toolResult("t2", "small output"),
      an.text("<system-reminder>…</system-reminder>"),
    ]);
    const snapshot = structuredClone(original);

    const replaced = anAccessor.replaceToolResult(original, "t1", "[truncated]");

    expect(original).toEqual(snapshot);
    expect(anAccessor.getToolResults(replaced)).toEqual([
      { toolCallId: "t1", text: "[truncated]", imageCount: 0, isError: false },
      { toolCallId: "t2", text: "small output", imageCount: 0, isError: false },
    ]);
    expect(anAccessor.toText(replaced)).toBe("<system-reminder>…</system-reminder>");
  });

  it("keeps opaque blocks untouched when replacing a server-side result", () => {
    const thinking = an.thinking("reasoning");
    const original = an.assistant([
      thinking,
      an.serverToolUse("s1", "web_search"),
      an.webSearchResult("s1", [{ title: "Docs", url: "https://example.com" }]),
    ]);

    const replaced = anAccessor.replaceToolResult(original, "s1", "[evicted]");

    expect(replaced.content).toContain(thinking);
    expect(anAccessor.getToolResults(replaced)).toEqual([
      { toolCallId: "s1", text: "[evicted]", imageCount: 0, isError: false },
    ]);
  });

  it("creates a harness summary message carrying the rendered text", () => {
    const summary = anAccessor.createSummaryMessage("## Goal\nShip it.");

    expect(anAccessor.getOrigin(summary)).toBe("harness");
    expect(anAccessor.toText(summary)).toBe("## Goal\nShip it.");
  });

  it("counts cache reads and writes as input tokens", () => {
    const msg = an.assistant("ok", {
      input_tokens: 50,
      output_tokens: 120,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 400,
    });

    expect(anAccessor.getUsage?.(msg)).toEqual({ inputTokens: 9450, outputTokens: 120 });
    expect(anAccessor.getUsage?.(an.assistant("ok"))).toBeUndefined();
    expect(anAccessor.getUsage?.(an.user("hi"))).toBeUndefined();
  });
});
