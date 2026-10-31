import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** A fresh directory, removed when the current test finishes. */
export function useTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-engine-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** IDs `id-1`, `id-2`, … in call order. */
export function counterIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A clock that starts at 2026-10-31T00:<minute>:00Z and advances one second per call. */
export function steppingClock(minute = 0): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 9, 31, 0, minute, seconds++));
}

/** The parsed lines of a JSONL file. */
export function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}
