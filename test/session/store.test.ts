import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLine,
  createFile,
  parseLines,
  repairTail,
  rewriteFile,
  writeAtomic,
} from "../../src/session/store.js";
import { useTempDir } from "../fixtures/session.js";

const header = { type: "session", version: 1, id: "s1", timestamp: "t", cwd: "/w" };
const jsonl = (...lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
const code = (c: string) => expect.objectContaining({ code: c });

describe("parseLines", () => {
  it("parses every line and skips blank ones", () => {
    const text = `${jsonl(header)}\n${jsonl({ id: "a" })}\r\n`;
    expect(parseLines(text, "f")).toEqual({ lines: [header, { id: "a" }], tornAt: undefined });
  });

  it("drops a torn last line and reports its byte offset", () => {
    const clean = jsonl(header, { id: "a", note: "héllo" }); // multi-byte character
    const parsed = parseLines(`${clean}{"id":"b","no`, "f");

    expect(parsed.lines).toEqual([header, { id: "a", note: "héllo" }]);
    expect(parsed.tornAt).toBe(Buffer.byteLength(clean));
  });

  it("treats a malformed line followed only by blank lines as the torn last line", () => {
    expect(parseLines(`${jsonl(header)}{oops\n\n`, "f").lines).toEqual([header]);
  });

  it("throws malformed_line with the line number for a broken line in the middle", () => {
    const text = `${jsonl(header)}{oops\n${jsonl({ id: "b" })}`;
    expect(() => parseLines(text, "s.jsonl")).toThrow(code("malformed_line"));
    expect(() => parseLines(text, "s.jsonl")).toThrow("s.jsonl:2");
  });

  it("throws invalid_header for an empty file, a torn header, or a non-session first line", () => {
    for (const text of ["", "\n", '{"type":"sess', jsonl({ type: "message" }), jsonl([1])]) {
      expect(() => parseLines(text, "f")).toThrow(code("invalid_header"));
    }
  });
});

describe("repairTail", () => {
  it("cuts a torn last line so the next append starts on a fresh line", () => {
    const file = join(useTempDir(), "s.jsonl");
    const text = `${jsonl(header)}{"id":"b","no`;
    writeFileSync(file, text);

    repairTail(file, text, parseLines(text, file));
    appendLine(file, { id: "c" });

    expect(parseLines(readFileSync(file, "utf8"), file).lines).toEqual([header, { id: "c" }]);
  });

  it("ends an unterminated valid last line", () => {
    const file = join(useTempDir(), "s.jsonl");
    const text = jsonl(header).trimEnd();
    writeFileSync(file, text);

    repairTail(file, text, parseLines(text, file));
    appendLine(file, { id: "c" });

    expect(readFileSync(file, "utf8")).toBe(jsonl(header, { id: "c" }));
  });

  it("leaves a clean file alone", () => {
    const file = join(useTempDir(), "s.jsonl");
    const text = jsonl(header);
    writeFileSync(file, text);

    repairTail(file, text, parseLines(text, file));

    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe("createFile", () => {
  it("creates the directory and writes one line per value", () => {
    const file = join(useTempDir(), "a", "b", "s.jsonl");
    createFile(file, [header, { id: "a" }]);
    expect(readFileSync(file, "utf8")).toBe(jsonl(header, { id: "a" }));
  });

  it("never overwrites an existing file", () => {
    const file = join(useTempDir(), "s.jsonl");
    writeFileSync(file, "other");

    expect(() => createFile(file, [header])).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(file, "utf8")).toBe("other");
  });
});

describe("rewriteFile / writeAtomic", () => {
  it("replace the content and leave no temp file behind", () => {
    const dir = useTempDir();
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "old");

    rewriteFile(file, [header]);

    expect(readFileSync(file, "utf8")).toBe(jsonl(header));
    expect(readdirSync(dir)).toEqual(["s.jsonl"]);
  });

  it("create missing directories", () => {
    const file = join(useTempDir(), "x", "MEMORY.md");
    writeAtomic(file, "# Memory\n");
    expect(existsSync(file)).toBe(true);
  });
});
