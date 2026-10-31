import { appendFileSync, mkdirSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionError } from "./types.js";

export interface ParsedLines {
  /** Line 1 is the header. A torn last line is left out. */
  lines: unknown[];
  /** Byte offset where a torn last line starts, when there is one. */
  tornAt?: number;
}

/**
 * Parses a session file's text. A malformed last line is a torn write from a crash and is
 * dropped; a malformed line anywhere else throws. Line 1 must be a session header (the
 * migration runner checks its version).
 */
export function parseLines(text: string, file: string): ParsedLines {
  const raw = text.split("\n");
  const lines: unknown[] = [];
  let tornAt: number | undefined;
  let offset = 0; // character offset of raw[i] in text
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim() !== "") {
      try {
        lines.push(JSON.parse(line));
      } catch (cause) {
        if (raw.slice(i + 1).some((rest) => rest.trim() !== "")) {
          throw new SessionError("malformed_line", `${file}:${i + 1}: unparseable line`, { cause });
        }
        tornAt = Buffer.byteLength(text.slice(0, offset));
        break;
      }
    }
    offset += line.length + 1;
  }

  const header = lines[0] as { type?: unknown } | null | undefined;
  if (typeof header !== "object" || header === null || header.type !== "session") {
    throw new SessionError("invalid_header", `${file}: line 1 is not a session header`);
  }
  return { lines, tornAt };
}

/** Makes `file` safe to append to: cuts a torn last line, or ends an unterminated one. */
export function repairTail(file: string, text: string, parsed: ParsedLines): void {
  if (parsed.tornAt !== undefined) truncateSync(file, parsed.tornAt);
  else if (!text.endsWith("\n")) appendFileSync(file, "\n");
}

const toJsonl = (lines: readonly unknown[]) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

/**
 * Creates `file` and its directory with `lines` in a single write. Fails if the file exists, so
 * it never overwrites another session. Not atomic: a crash can leave a torn last line.
 */
export function createFile(file: string, lines: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toJsonl(lines), { flag: "wx" });
}

export function appendLine(file: string, line: unknown): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** Replaces `file` with `lines` atomically (see `writeAtomic`). */
export function rewriteFile(file: string, lines: readonly unknown[]): void {
  writeAtomic(file, toJsonl(lines));
}

/**
 * Writes `data` to a temp file next to `file`, then renames it over `file`, so a crash leaves
 * either the old or the new content. Creates the directory.
 */
export function writeAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
