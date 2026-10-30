import { describe, expect, it } from "vitest";
import {
  buildContext,
  collectReplacements,
  renderSummary,
  resolveContextEntries,
} from "../../src/compaction/context.js";
import { FileOpsExtractor } from "../../src/compaction/extractors/file-ops.js";
import { ExtractorRegistry } from "../../src/compaction/extractors/registry.js";
import { CompactionError } from "../../src/compaction/types.js";
import { an, anAccessor } from "../fixtures/anthropic-like.js";
import { buildPath, compaction, message, prune } from "../fixtures/entries.js";
import { oa, oaAccessor } from "../fixtures/openai-like.js";

const extractors = new ExtractorRegistry([new FileOpsExtractor()]);
const item = (toolCallId: string, replacement: string) => ({
  toolCallId,
  replacement,
  tokensBefore: 1000,
  tokensAfter: 10,
});

describe("buildContext", () => {
  it("returns every message entry, uncopied, when there is nothing to compact or replace", () => {
    const msgs = [oa.user("hi"), oa.assistant("hello"), oa.user("bye")];
    const path = buildPath([
      message(msgs[0]),
      message(msgs[1]),
      { type: "label", label: "x" },
      message(msgs[2]),
    ]);

    const context = buildContext(path, oaAccessor, extractors);

    expect(context).toHaveLength(3);
    for (const [i, msg] of context.entries()) expect(msg).toBe(msgs[i]);
  });

  it("applies prune replacements, later entries winning, without touching stored messages", () => {
    const result = oa.tool("c1", "huge output");
    const path = buildPath([
      message(oa.assistant(null, [oa.call("c1", "bash")])),
      message(result),
      prune([item("c1", "[first]")]),
      prune([item("c1", "[second]")]),
    ]);

    const context = buildContext(path, oaAccessor, extractors);

    expect(oaAccessor.getToolResults(context[1])[0].text).toBe("[second]");
    expect(result.content).toBe("huge output");
  });

  it("replaces a single result inside a batched user message", () => {
    const path = buildPath([
      message(an.assistant([an.toolUse("t1", "bash"), an.toolUse("t2", "bash")])),
      message(an.user([an.toolResult("t1", "big"), an.toolResult("t2", "small")])),
      prune([item("t1", "[cut]")]),
    ]);

    const [, results] = buildContext(path, anAccessor, extractors);

    expect(anAccessor.getToolResults(results).map((r) => r.text)).toEqual(["[cut]", "small"]);
  });

  it("starts with the rendered summary, then the kept entries before the compaction and everything after", () => {
    const path = buildPath([
      message(oa.user("old request")), // e0: summarized
      message(oa.assistant("old answer")), // e1: summarized
      message(oa.user("kept request")), // e2: first kept
      message(oa.assistant("kept answer")), // e3
      compaction("e2", {
        summary: "## Goal\nShip it.",
        details: { file_operations: { readFiles: ["a.ts"], modifiedFiles: [] } },
      }),
      message(oa.user("new request")), // e5
    ]);

    const context = buildContext(path, oaAccessor, extractors);

    expect(context.map((m) => oaAccessor.toText(m))).toEqual([
      "## Goal\nShip it.\n\n<read-files>\na.ts\n</read-files>",
      "kept request",
      "kept answer",
      "new request",
    ]);
    expect(oaAccessor.getOrigin(context[0])).toBe("harness");
  });

  it("uses only the latest compaction", () => {
    const path = buildPath([
      message(oa.user("one")),
      message(oa.user("two")),
      compaction("e1", { summary: "first summary" }),
      message(oa.user("three")),
      compaction("e3", { summary: "second summary" }),
      message(oa.user("four")),
    ]);

    expect(buildContext(path, oaAccessor, extractors).map((m) => oaAccessor.toText(m))).toEqual([
      "second summary",
      "three",
      "four",
    ]);
  });

  it("keeps applying replacements recorded before the compaction to kept messages", () => {
    const path = buildPath([
      message(oa.user("go")),
      message(oa.assistant(null, [oa.call("c1", "bash")])), // e1: first kept
      message(oa.tool("c1", "huge output")),
      prune([item("c1", "[cut]")]),
      compaction("e1"),
    ]);

    const context = buildContext(path, oaAccessor, extractors);

    expect(oaAccessor.getToolResults(context[2])[0].text).toBe("[cut]");
  });

  it("throws missing_kept_entry when the kept entry is not on the path", () => {
    const path = buildPath([message(oa.user("hi")), compaction("gone")]);

    expect(() => buildContext(path, oaAccessor, extractors)).toThrow(
      expect.objectContaining({ code: "missing_kept_entry" }),
    );
    expect(() => buildContext(path, oaAccessor, extractors)).toThrow(CompactionError);
  });
});

describe("resolveContextEntries", () => {
  it("returns the latest compaction and the message entries from its kept window", () => {
    const path = buildPath([
      message(oa.user("one")),
      message(oa.user("two")),
      compaction("e1"),
      message(oa.user("three")),
    ]);

    const { compaction: latest, messages } = resolveContextEntries(path);

    expect(latest?.id).toBe("e2");
    expect(messages.map((e) => e.id)).toEqual(["e1", "e3"]);
  });
});

describe("collectReplacements", () => {
  it("maps tool call IDs to their latest replacement", () => {
    const path = buildPath([
      prune([item("c1", "a"), item("c2", "b")]),
      message(oa.user("x")),
      prune([item("c1", "c")]),
    ]);

    expect(collectReplacements(path)).toEqual(
      new Map([
        ["c1", "c"],
        ["c2", "b"],
      ]),
    );
  });
});

describe("renderSummary", () => {
  it("appends the extractors' blocks after a blank line", () => {
    const details = { file_operations: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] } };

    expect(renderSummary("## Goal\nShip it.", details, extractors)).toBe(
      "## Goal\nShip it.\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>",
    );
  });

  it("returns the summary alone when no block renders", () => {
    expect(renderSummary("## Goal\nShip it.", {}, extractors)).toBe("## Goal\nShip it.");
  });
});
