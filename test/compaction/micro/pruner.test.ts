import { describe, expect, it } from "vitest";
import {
  evictionStub,
  toolResultTokens,
  truncateToolResult,
} from "../../../src/compaction/micro/pruner.js";
import { DEFAULT_IMAGE_TOKENS } from "../../../src/compaction/tokens.js";
import type { ToolResultInfo } from "../../../src/compaction/types.js";

const limits = { maxTokens: 1000, preserveHeadLines: 20, preserveTailLines: 20, maxLineChars: 500 };
const maxChars = 4000; // maxTokens × 4

const result = (text: string, imageCount = 0): ToolResultInfo => ({
  toolCallId: "c1",
  text,
  imageCount,
  isError: false,
});

/** `count` lines "line 0", "line 1", …, each padded with dots to `width` characters. */
const numbered = (count: number, width = 0) =>
  Array.from({ length: count }, (_, i) => `line ${i}`.padEnd(width, "."));

const STUB = /\[\.\.\. truncated \d+ lines \/ \d+ chars; original \d+ lines \.\.\.\]/g;

describe("truncateToolResult", () => {
  it("returns null for results within the limit", () => {
    expect(truncateToolResult(result("x".repeat(maxChars)), limits)).toBeNull();
    expect(
      truncateToolResult(result("x".repeat(100_000), 3), { ...limits, maxTokens: Infinity }),
    ).toBeNull();
  });

  it("keeps the head and tail lines of a 5,000-line output around a stub", () => {
    const lines = numbered(5000);

    const out = truncateToolResult(result(lines.join("\n")), limits);

    // The omitted characters include the line breaks on either side of the omitted lines.
    const omittedChars = lines.slice(20, 4980).join("\n").length + 2;
    expect(out).toBe(
      [
        ...lines.slice(0, 20),
        `[... truncated 4960 lines / ${omittedChars} chars; original 5000 lines ...]`,
        ...lines.slice(4980),
      ].join("\n"),
    );
  });

  it("cuts a single 1 MB line to maxLineChars", () => {
    expect(truncateToolResult(result("x".repeat(1_000_000)), limits)).toBe(
      `${"x".repeat(500)}…[+999500 chars]`,
    );
  });

  it("cuts long lines that stay visible", () => {
    const lines = numbered(1000);
    lines[0] = "a".repeat(800);
    lines[999] = "z".repeat(600);

    const out = (truncateToolResult(result(lines.join("\n")), limits) ?? "").split("\n");

    expect(out[0]).toBe(`${"a".repeat(500)}…[+300 chars]`);
    expect(out.at(-1)).toBe(`${"z".repeat(500)}…[+100 chars]`);
  });

  it("hard-cuts by characters when the kept lines are still over the limit", () => {
    const lines = numbered(100, 400);

    const out = truncateToolResult(result(lines.join("\n")), limits) ?? "";

    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out.startsWith(lines[0])).toBe(true);
    expect(out.endsWith(lines[99])).toBe(true);
    expect(out.match(STUB)).toEqual([
      expect.stringMatching(/truncated 90 lines \/ \d+ chars; original 100 lines/),
    ]);
  });

  it("hard-cuts a short output of long lines, keeping both ends", () => {
    const lines = numbered(10, 480);

    const out = truncateToolResult(result(lines.join("\n")), limits) ?? "";

    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out.startsWith(lines[0])).toBe(true);
    expect(out.endsWith(lines[9])).toBe(true);
    expect(out.match(STUB)).toEqual([expect.stringContaining("original 10 lines")]);
  });

  it("drops images, keeps text that fits, and notes how many images were removed", () => {
    expect(truncateToolResult(result("screenshot of the login page", 2), limits)).toBe(
      "screenshot of the login page\n[2 image(s) removed]",
    );
    expect(truncateToolResult(result("", 1), limits)).toBe("[1 image(s) removed]");
  });

  it("fits truncated text and the image note within the limit", () => {
    const out = truncateToolResult(result(numbered(1000, 300).join("\n"), 1), limits) ?? "";

    expect(out.endsWith("\n[1 image(s) removed]")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(maxChars);
  });
});

describe("toolResultTokens", () => {
  it("counts text and a fixed cost per image", () => {
    expect(toolResultTokens(result("x".repeat(40), 2))).toBe(10 + 2 * DEFAULT_IMAGE_TOKENS);
    expect(toolResultTokens(result("x".repeat(40), 2), 500)).toBe(10 + 2 * 500);
  });
});

describe("evictionStub", () => {
  it("names the path and the size of the evicted result", () => {
    expect(evictionStub("src/a.ts", "a\nb\nc")).toBe(
      "[Tool result evicted: src/a.ts was read again or modified later; original 3 lines / 5 chars]",
    );
  });
});
