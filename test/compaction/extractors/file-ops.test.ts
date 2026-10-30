import { describe, expect, it } from "vitest";
import {
  type FileOpsDetails,
  FileOpsExtractor,
} from "../../../src/compaction/extractors/file-ops.js";
import type { ToolObservation } from "../../../src/compaction/extractors/types.js";
import { observation } from "../../fixtures/observations.js";

function extract(
  observations: ToolObservation[],
  extractor = new FileOpsExtractor(),
  previous?: unknown,
): FileOpsDetails {
  const state = extractor.createState();
  extractor.mergePrevious(previous, state);
  for (const obs of observations) extractor.observe(obs, state);
  return extractor.serialize(state);
}

describe("FileOpsExtractor", () => {
  it("tracks successful reads and modifications by tool name", () => {
    const details = extract([
      observation("read", { path: "a.ts" }),
      observation("write", { path: "b.ts" }),
      observation("edit", { path: "c.ts" }),
      observation("view", { path: "d.ts" }),
      observation("create", { path: "e.ts" }),
      observation("str_replace_editor", { path: "f.ts" }),
      observation("read_file", { path: "g.ts" }),
      observation("write_file", { path: "h.ts" }),
      observation("patch", { path: "i.ts" }),
    ]);

    expect(details).toEqual({
      readFiles: ["a.ts", "d.ts", "g.ts"],
      modifiedFiles: ["b.ts", "c.ts", "e.ts", "f.ts", "h.ts", "i.ts"],
    });
  });

  it("takes the path from the first configured argument key that holds a string", () => {
    const details = extract([
      observation("read", { file_path: "a.ts" }),
      observation("read", { filePath: "b.ts" }),
      observation("read", { file: "c.ts" }),
      observation("read", { path: "d.ts", file_path: "ignored.ts" }),
      observation("read", { path: 42, file: "e.ts" }),
    ]);

    expect(details.readFiles).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  it("ignores failed calls and calls that never got a result", () => {
    const details = extract([
      observation("read", { path: "missing.ts" }, "error"),
      observation("edit", { path: "a.ts" }, "error"),
      observation("write", { path: "b.ts" }, "none"),
    ]);

    expect(details).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("ignores other tools, missing paths, and unparsed arguments", () => {
    const details = extract([
      observation("bash", { path: "a.ts" }),
      observation("read", {}),
      observation("read", { path: 42 }),
      observation("edit", undefined),
    ]);

    expect(details).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("normalizes paths so different spellings of one file collapse", () => {
    const details = extract([
      observation("read", { path: "./src\\a.ts" }),
      observation("read", { path: "src/a.ts" }),
      observation("edit", { path: ".\\src\\b.ts" }),
    ]);

    expect(details).toEqual({ readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });
  });

  it("moves re-touched files to the newest position and drops the oldest past the cap", () => {
    const details = extract(
      [
        observation("read", { path: "a.ts" }),
        observation("read", { path: "b.ts" }),
        observation("read", { path: "a.ts" }),
        observation("read", { path: "c.ts" }),
      ],
      new FileOpsExtractor({ maxFilesPerList: 2 }),
    );

    expect(details.readFiles).toEqual(["a.ts", "c.ts"]);
  });

  it("merges previous details as older than anything observed now", () => {
    const details = extract(
      [observation("read", { path: "a.ts" }), observation("edit", { path: "n.ts" })],
      new FileOpsExtractor(),
      { readFiles: ["a.ts", "x.ts"], modifiedFiles: ["m.ts"] },
    );

    expect(details).toEqual({ readFiles: ["x.ts", "a.ts"], modifiedFiles: ["m.ts", "n.ts"] });
  });

  it("reads malformed previous details as empty", () => {
    expect(extract([], new FileOpsExtractor(), "garbage")).toEqual({
      readFiles: [],
      modifiedFiles: [],
    });
    expect(
      extract([], new FileOpsExtractor(), { readFiles: "abc", modifiedFiles: [1, "ok.ts"] }),
    ).toEqual({ readFiles: [], modifiedFiles: ["ok.ts"] });
  });

  it("applies a partial config over the defaults", () => {
    const extractor = new FileOpsExtractor({
      readTools: ["cat"],
      normalizePath: (p) => p.toLowerCase(),
    });

    const details = extract(
      [
        observation("cat", { path: "README.md" }),
        observation("read", { path: "a.ts" }),
        observation("edit", { path: "SRC/B.ts" }),
      ],
      extractor,
    );

    expect(details).toEqual({ readFiles: ["readme.md"], modifiedFiles: ["src/b.ts"] });
  });

  it("classifies calls for superseded-read detection", () => {
    const extractor = new FileOpsExtractor();
    const call = (name: string, args?: Record<string, unknown>) => ({
      id: "c1",
      name,
      arguments: args,
    });

    expect(extractor.classify(call("read", { path: "./a.ts" }))).toEqual({
      kind: "read",
      path: "a.ts",
    });
    expect(extractor.classify(call("edit", { file_path: "a.ts" }))).toEqual({
      kind: "modify",
      path: "a.ts",
    });
    expect(extractor.classify(call("bash", { path: "a.ts" }))).toBeUndefined();
    expect(extractor.classify(call("read"))).toBeUndefined();
  });

  describe("render", () => {
    const extractor = new FileOpsExtractor();

    it("lists read-only and modified files in sorted blocks", () => {
      const rendered = extractor.render({
        readFiles: ["z.ts", "a.ts", "m.ts"],
        modifiedFiles: ["m.ts", "b.ts"],
      });

      expect(rendered).toBe(
        "<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nb.ts\nm.ts\n</modified-files>",
      );
    });

    it("omits the read block when every read file was also modified", () => {
      expect(extractor.render({ readFiles: ["a.ts"], modifiedFiles: ["a.ts"] })).toBe(
        "<modified-files>\na.ts\n</modified-files>",
      );
    });

    it("renders nothing without files or details", () => {
      expect(extractor.render({ readFiles: [], modifiedFiles: [] })).toBe("");
      expect(extractor.render(undefined)).toBe("");
    });
  });
});
