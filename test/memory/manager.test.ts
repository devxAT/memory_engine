import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetMemory, insertNote, MemoryManager } from "../../src/memory/manager.js";
import type { MemoryConfig } from "../../src/memory/types.js";
import { projectDir } from "../../src/session/paths.js";
import { useTempDir } from "../fixtures/session.js";

const memory = (root: string, config: Partial<MemoryConfig> = {}) =>
  new MemoryManager({ storageRoot: root, projectId: "proj", ...config });

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("budgetMemory", () => {
  const limits = { maxLines: 3, maxChars: 1000, filePath: "/p/MEMORY.md" };

  it("returns text within budget unchanged, trailing newline included", () => {
    expect(budgetMemory("a\nb\nc\n", limits)).toBe("a\nb\nc\n");
  });

  it("keeps the first maxLines lines and says how many more there are and where", () => {
    expect(budgetMemory(`${numbered(5)}\n`, limits)).toBe(
      "line 1\nline 2\nline 3\n\n[... 2 more lines in /p/MEMORY.md not loaded to preserve the context budget ...]",
    );
  });

  it("drops whole lines to fit maxChars, not counting the footer", () => {
    // "line 1\nline 2" is 13 characters; adding "\nline 3" would make 20.
    const out = budgetMemory(numbered(3), { ...limits, maxChars: 19 });
    expect(out.split("\n\n")[0]).toBe("line 1\nline 2");
    expect(out).toContain("1 more line in");
  });

  it("cuts a first line longer than maxChars", () => {
    const out = budgetMemory(`${"x".repeat(50)}\nnext`, { ...limits, maxChars: 10 });
    expect(out).toBe(
      `${"x".repeat(10)}\n\n[... 2 more lines in /p/MEMORY.md not loaded to preserve the context budget ...]`,
    );
  });
});

describe("insertNote", () => {
  const file = [
    "# Project Memory",
    "",
    "## Conventions",
    "- Use pnpm.",
    "### Testing",
    "- Vitest only.",
    "",
    "",
    "## Architecture",
    "- Two-tier compaction.",
    "",
  ].join("\n");

  it("creates the default structure for a missing or blank file", () => {
    const expected = "# Project Memory\n\n## Preferences\n- Be concise.\n";
    expect(insertNote(null, "Preferences", "Be concise.")).toBe(expected);
    expect(insertNote("  \n", "Preferences", "Be concise.")).toBe(expected);
  });

  it("adds the bullet after the section's last non-blank line, ### subheadings included", () => {
    expect(insertNote(file, "Conventions", "Run lint before commits.")).toBe(
      file.replace("- Vitest only.\n", "- Vitest only.\n- Run lint before commits.\n"),
    );
  });

  it("adds the last section's bullet at the end of the file", () => {
    expect(insertNote(file, "Architecture", "No SDK imports.")).toBe(
      file.replace("- Two-tier compaction.\n", "- Two-tier compaction.\n- No SDK imports.\n"),
    );
  });

  it("appends a missing heading after one blank line", () => {
    expect(
      insertNote("# Project Memory\n\n## Conventions\n- a\n\n\n", "Environment", "Node 22"),
    ).toBe("# Project Memory\n\n## Conventions\n- a\n\n## Environment\n- Node 22\n");
  });

  it("matches the heading exactly, ignoring trailing whitespace", () => {
    const text = "## Conventions & Rules\n- a\n\n## Conventions  \n- b\n";
    expect(insertNote(text, "Conventions", "c")).toBe(`${text}- c\n`);
  });

  it("collapses a multi-line note into one bullet and trims it", () => {
    expect(insertNote(null, "Conventions", "  first line\n  second line \r\n")).toContain(
      "- first line second line\n",
    );
  });

  it("returns null for an empty note or a bullet the section already has", () => {
    expect(insertNote(file, "Conventions", "  \n ")).toBeNull();
    expect(insertNote(file, "Conventions", "Use pnpm.")).toBeNull();
    expect(insertNote(file, "Architecture", "Use pnpm.")).not.toBeNull(); // other section
  });

  it("rejects an empty or multi-line category", () => {
    expect(() => insertNote(null, " ", "x")).toThrow("Invalid memory category");
    expect(() => insertNote(null, "A\nB", "x")).toThrow("Invalid memory category");
  });
});

describe("MemoryManager", () => {
  it("stores MEMORY.md in the project directory, or a custom file name", () => {
    const root = useTempDir();
    expect(memory(root).filePath).toBe(join(projectDir(root, "proj"), "MEMORY.md"));
    expect(memory(root, { fileName: "NOTES.md" }).filePath).toBe(
      join(projectDir(root, "proj"), "NOTES.md"),
    );
  });

  it("rejects an invalid projectId or file name", () => {
    const root = useTempDir();
    expect(() => memory(root, { projectId: "../x" })).toThrow(
      expect.objectContaining({ code: "invalid_project_id" }),
    );
    expect(() => memory(root, { fileName: "../MEMORY.md" })).toThrow("Invalid memory file name");
  });

  it("reads null for a missing or blank file", () => {
    const mem = memory(useTempDir());
    expect(mem.exists()).toBe(false);
    expect(mem.readMemory()).toBeNull();
    expect(mem.readFullMemory()).toBeNull();

    mem.writeMemory("\n  \n");

    expect(mem.exists()).toBe(true);
    expect(mem.readMemory()).toBeNull();
    expect(mem.readFullMemory()).toBe("\n  \n");
  });

  it("budgets readMemory with the configured limits (default 200 lines), overridable per call", () => {
    const root = useTempDir();
    const text = `${numbered(250)}\n`;
    memory(root).writeMemory(text);

    expect(memory(root).readMemory()).toContain("line 200\n\n[... 50 more lines in");
    expect(memory(root, { maxContextLines: 10 }).readMemory()).toContain("line 10\n\n[... 240");
    expect(memory(root).readMemory({ maxLines: 2 })).toMatch(/^line 1\nline 2\n\n\[\.\.\. 248/);
    expect(memory(root).readMemory({ maxLines: 300, maxChars: 100_000 })).toBe(text);
    expect(memory(root).readFullMemory()).toBe(text);
  });

  it("writes atomically: directories created, no temp file left", () => {
    const root = useTempDir();
    const mem = memory(root);

    mem.writeMemory("# One\n");
    mem.writeMemory("# Two\n");

    expect(readFileSync(mem.filePath, "utf8")).toBe("# Two\n");
    expect(readdirSync(projectDir(root, "proj"))).toEqual(["MEMORY.md"]);
  });

  it("appends notes under their category headings", () => {
    const mem = memory(useTempDir());
    mem.appendNote("Conventions", "Use pnpm.");
    mem.appendNote("Environment", "Node 22.");
    mem.appendNote("Conventions", "Run lint.");
    mem.appendNote("Conventions", "Run lint."); // duplicate

    expect(mem.readFullMemory()).toBe(
      "# Project Memory\n\n## Conventions\n- Use pnpm.\n- Run lint.\n\n## Environment\n- Node 22.\n",
    );
  });

  it("does not create a file for an empty note", () => {
    const mem = memory(useTempDir());
    mem.appendNote("Conventions", "   ");
    expect(mem.exists()).toBe(false);
  });

  it("keeps hand-edited content when appending", () => {
    const mem = memory(useTempDir());
    mem.writeMemory("# Mine\n\nFree text.\n");

    mem.appendNote("Preferences", "Short answers.");

    expect(mem.readFullMemory()).toBe("# Mine\n\nFree text.\n\n## Preferences\n- Short answers.\n");
  });

  it("clear deletes the file and is a no-op when it is missing", () => {
    const mem = memory(useTempDir());
    mem.clear();
    mem.writeMemory("x");

    mem.clear();

    expect(existsSync(mem.filePath)).toBe(false);
  });
});
