import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPathSegment, projectDir } from "../session/paths.js";
import { writeAtomic } from "../session/store.js";
import {
  DEFAULT_MAX_CONTEXT_CHARS,
  DEFAULT_MAX_CONTEXT_LINES,
  DEFAULT_MEMORY_FILE_NAME,
  type MemoryCategory,
  type MemoryConfig,
  type ReadMemoryOptions,
} from "./types.js";

/**
 * The first `maxLines` lines, then whole lines dropped from the end until the text fits in
 * `maxChars` (a first line longer than that is cut). When anything is left out, a footer says
 * how much and where the rest is; the footer is not counted. Otherwise `text` is returned as-is.
 */
export function budgetMemory(
  text: string,
  limits: { maxLines: number; maxChars: number; filePath: string },
): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline is not a line

  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, limits.maxLines)) {
    const next = chars + (kept.length > 0 ? 1 : 0) + line.length; // "\n" between lines
    if (next > limits.maxChars) break;
    kept.push(line);
    chars = next;
  }
  if (kept.length === lines.length) return text;

  let shown = kept.join("\n");
  if (kept.length === 0 && limits.maxLines > 0) shown = lines[0].slice(0, limits.maxChars);
  const omitted = lines.length - kept.length;
  const footer = `[... ${omitted} more line${omitted === 1 ? "" : "s"} in ${limits.filePath} not loaded to preserve the context budget ...]`;
  return shown === "" ? footer : `${shown}\n\n${footer}`;
}

/**
 * `text` with `- <note>` added at the end of the `## <category>` section, which is created at
 * the end of the file if missing. A missing or blank file gets the default structure. Returns
 * null when nothing changes: an empty note, or a bullet the section already has.
 */
export function insertNote(text: string | null, category: string, note: string): string | null {
  const name = category.trim();
  if (name === "" || /[\r\n]/.test(name)) {
    throw new Error(`Invalid memory category: ${JSON.stringify(category)}`);
  }
  const content = note.trim().replace(/\s*[\r\n]+\s*/g, " ");
  if (content === "") return null;

  const heading = `## ${name}`;
  const bullet = `- ${content}`;
  if (text === null || text.trim() === "") return `# Project Memory\n\n${heading}\n${bullet}\n`;

  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return `${text.trimEnd()}\n\n${heading}\n${bullet}\n`;

  // The section runs to the next `#` or `##` heading; `###` subheadings belong to it.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);
  if (section.some((line) => line.trimEnd() === bullet)) return null;

  let insertAt = start + 1;
  for (let i = end - 1; i > start; i--) {
    if (lines[i].trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}

/**
 * The project's cross-session memory: a Markdown file next to the sessions directory. It stores
 * and budgets notes; the host decides what to remember. Every write is atomic. One writer at a
 * time.
 */
export class MemoryManager {
  readonly filePath: string;
  private readonly maxContextLines: number;
  private readonly maxContextChars: number;

  constructor(config: MemoryConfig) {
    const fileName = config.fileName ?? DEFAULT_MEMORY_FILE_NAME;
    if (!isPathSegment(fileName)) {
      throw new Error(`Invalid memory file name: ${JSON.stringify(fileName)}`);
    }
    this.filePath = join(projectDir(config.storageRoot, config.projectId), fileName);
    this.maxContextLines = config.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES;
    this.maxContextChars = config.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  }

  /** For the system prompt: within the line/character budget, or null if missing or blank. */
  readMemory(options: ReadMemoryOptions = {}): string | null {
    const text = this.readFullMemory();
    if (text === null || text.trim() === "") return null;
    return budgetMemory(text, {
      maxLines: options.maxLines ?? this.maxContextLines,
      maxChars: options.maxChars ?? this.maxContextChars,
      filePath: this.filePath,
    });
  }

  /** The whole file, or null if it does not exist. */
  readFullMemory(): string | null {
    try {
      return readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Replaces the file's content. Creates the directory if needed. */
  writeMemory(content: string): void {
    writeAtomic(this.filePath, content);
  }

  /** Adds a bullet under `## <category>`, creating the heading or the file as needed. */
  appendNote(category: MemoryCategory, note: string): void {
    const updated = insertNote(this.readFullMemory(), category, note);
    if (updated !== null) writeAtomic(this.filePath, updated);
  }

  /** Deletes the file; no-op if it does not exist. */
  clear(): void {
    rmSync(this.filePath, { force: true });
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
