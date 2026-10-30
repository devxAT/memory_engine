import { describe, expect, it } from "vitest";
import { FileOpsExtractor } from "../../../src/compaction/extractors/file-ops.js";
import { ExtractorRegistry } from "../../../src/compaction/extractors/registry.js";
import type { ExtractorPlugin } from "../../../src/compaction/extractors/types.js";
import { observation } from "../../fixtures/observations.js";

/** Counts calls per tool name; renders nothing when there are none. */
function toolCounter(name = "tool_counts"): ExtractorPlugin<Map<string, number>> {
  const read = (details: unknown) => Object.entries((details ?? {}) as Record<string, number>);
  return {
    name,
    createState: () => new Map(),
    mergePrevious(previous, state) {
      for (const [tool, count] of read(previous)) state.set(tool, count);
    },
    observe({ call }, state) {
      state.set(call.name, (state.get(call.name) ?? 0) + 1);
    },
    serialize: (state) => Object.fromEntries(state),
    render(details) {
      const counts = read(details).map(([tool, count]) => `${tool}=${count}`);
      return counts.length > 0 ? `<tool-counts>${counts.join(" ")}</tool-counts>` : "";
    },
  };
}

describe("ExtractorRegistry", () => {
  it("runs every plugin over the observations and keys details by plugin name", () => {
    const registry = new ExtractorRegistry([toolCounter(), new FileOpsExtractor()]);

    const details = registry.run([
      observation("read", { path: "a.ts" }),
      observation("bash", { command: "ls" }),
      observation("read", { path: "b.ts" }),
    ]);

    expect(details).toEqual({
      tool_counts: { read: 2, bash: 1 },
      file_operations: { readFiles: ["a.ts", "b.ts"], modifiedFiles: [] },
    });
  });

  it("merges each plugin's previous details before observing", () => {
    const registry = new ExtractorRegistry([toolCounter(), new FileOpsExtractor()]);

    const details = registry.run([observation("read", { path: "b.ts" })], {
      tool_counts: { read: 3, edit: 1 },
      file_operations: { readFiles: ["a.ts"], modifiedFiles: ["c.ts"] },
    });

    expect(details).toEqual({
      tool_counts: { read: 4, edit: 1 },
      file_operations: { readFiles: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] },
    });
  });

  it("drops previous details of plugins that are no longer registered", () => {
    const registry = new ExtractorRegistry([toolCounter()]);

    expect(registry.run([], { removed_plugin: { anything: true } })).toEqual({ tool_counts: {} });
  });

  it("starts every run from fresh state", () => {
    const registry = new ExtractorRegistry([toolCounter()]);
    registry.run([observation("read"), observation("read")]);

    expect(registry.run([observation("bash")])).toEqual({ tool_counts: { bash: 1 } });
  });

  it("renders non-empty blocks in registration order, separated by blank lines", () => {
    const registry = new ExtractorRegistry([toolCounter(), new FileOpsExtractor()]);
    const files = { readFiles: ["a.ts"], modifiedFiles: [] };

    expect(registry.render({ tool_counts: { read: 1 }, file_operations: files })).toBe(
      "<tool-counts>read=1</tool-counts>\n\n<read-files>\na.ts\n</read-files>",
    );
    expect(registry.render({ tool_counts: {}, file_operations: files })).toBe(
      "<read-files>\na.ts\n</read-files>",
    );
    expect(registry.render({})).toBe("");
  });

  it("rejects a second plugin with the same name", () => {
    const registry = new ExtractorRegistry([toolCounter("dup")]);

    expect(() => registry.register(toolCounter("dup"))).toThrow('"dup" is already registered');
  });

  it("looks plugins up by name", () => {
    const fileOps = new FileOpsExtractor();
    const registry = new ExtractorRegistry([fileOps]);

    expect(registry.get("file_operations")).toBe(fileOps);
    expect(registry.get("missing")).toBeUndefined();
  });
});
