import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionError, type SessionHeader } from "./types.js";

const MAX_SLUG_LENGTH = 200;

/** True for a non-empty name without path separators that is not `.` or `..`. */
export function isPathSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
}

/**
 * A project ID derived from a working directory, the way Claude Code does: every character
 * outside `[A-Za-z0-9]` becomes `-`. The path is used as given (pass an absolute one, such as
 * `process.cwd()`). Slugs over 200 characters are cut and suffixed with a hash of the full path.
 */
export function projectIdFromCwd(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG_LENGTH)}-${hash}`;
}

/** `<storageRoot>/<projectId>`: holds `MEMORY.md` and the sessions directory. */
export function projectDir(storageRoot: string, projectId: string): string {
  if (!isPathSegment(projectId)) {
    throw new SessionError(
      "invalid_project_id",
      `Invalid project ID: ${JSON.stringify(projectId)}`,
    );
  }
  return join(storageRoot, projectId);
}

/** `<storageRoot>/<projectId>/sessions`. */
export function sessionsDir(storageRoot: string, projectId: string): string {
  return join(projectDir(storageRoot, projectId), "sessions");
}

/** `<timestamp>_<id>.jsonl`, with `:` and `.` in the timestamp replaced so it is valid on Windows. */
export function sessionFileName(header: Pick<SessionHeader, "id" | "timestamp">): string {
  return `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
}

/** The session ID in a `sessionFileName`, or undefined for other names. The timestamp has no `_`. */
export function sessionIdFromFileName(name: string): string | undefined {
  const separator = name.indexOf("_");
  if (separator === -1 || !name.endsWith(".jsonl")) return undefined;
  const id = name.slice(separator + 1, -".jsonl".length);
  return id === "" ? undefined : id;
}
