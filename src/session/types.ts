import type { MessageAccessor, SessionEntry, SessionEntryBase } from "../compaction/types.js";

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

/** Line 1 of every session file. Written once; only a migration rewrite changes it. */
export interface SessionHeader {
  type: "session";
  /** Engine schema version; `CURRENT_SESSION_VERSION` when written. */
  version: number;
  id: string;
  /** ISO-8601 creation time. */
  timestamp: string;
  /** Working directory of the workspace. */
  cwd: string;
  /** Host message format and version, opaque to the engine (e.g. "my-agent/messages@3"). */
  messageFormat?: string;
  /** Initial title. Later renames are `title` entries. */
  title?: string;
  /** Set on forks: the session this one was copied from. */
  parentSessionId?: string;
  /** Set on forks: the last entry copied from the parent. */
  forkedFromEntryId?: string;
  /** Host-defined metadata (e.g. git branch, model name, agent role). */
  metadata?: Record<string, unknown>;
}

/** A rename. The last one in the file wins over `SessionHeader.title`. */
export interface TitleEntry extends SessionEntryBase {
  type: "title";
  title: string;
}

/** Host-specific events. Every other unknown `type` is reserved for the engine. */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  /** Host-defined event name, e.g. "bookmark" or "model_change". */
  customType: string;
  data?: T;
}

// Interfaces are not assignable to the catch-all member of `SessionEntry` (no index signature),
// so these guards take any entry-like value instead of `SessionEntry<TMsg>`.

export function isTitleEntry(entry: { type: string }): entry is TitleEntry {
  return entry.type === "title";
}

export function isCustomEntry(entry: { type: string }): entry is CustomEntry {
  return entry.type === "custom";
}

/** The last `title` entry's title, or else the header's. */
export function effectiveTitle<TMsg>(
  header: SessionHeader,
  entries: readonly SessionEntry<TMsg>[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isTitleEntry(entry)) return entry.title;
  }
  return header.title;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SessionConfig<TMsg> {
  /** Directory where all projects are stored. */
  storageRoot: string;
  /** A single path segment (see `projectIdFromCwd`). */
  projectId: string;
  cwd: string;
  /** Default: true. False keeps everything in memory and never writes. */
  persist?: boolean;
  title?: string;
  metadata?: Record<string, unknown>;
  /** Recorded in the header. */
  messageFormat?: string;
  /** When given, the first appended message with origin "model" flushes the session. */
  accessor?: Pick<MessageAccessor<TMsg>, "getOrigin">;
  /** Default: `crypto.randomUUID`. Used for session and entry IDs. */
  generateId?: () => string;
  /** Default: `() => new Date()`. */
  now?: () => Date;
}

export interface OpenOptions<TMsg> {
  /** Default: true. False reads the file, keeps new entries in memory, and never writes. */
  persist?: boolean;
  /** Expected host message format; a different one in the file needs `upgradeMessage`. */
  messageFormat?: string;
  upgradeMessage?: (message: unknown, fromFormat: string | undefined) => TMsg;
  generateId?: () => string;
  now?: () => Date;
}

export interface ForkOptions {
  /** Default: the parent's title at the fork point. */
  title?: string;
  /** Default: the parent's. */
  cwd?: string;
  /** Shallow-merged over the parent's metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  path: string;
  /** Effective title, or null. */
  title: string | null;
  cwd: string;
  /** Header timestamp. */
  created: Date;
  /** Last entry's timestamp (the header's if none). Unlike file mtime, survives copies and syncs. */
  modified: Date;
  /** Number of message entries. */
  messageCount: number;
  /** Text of the first human message with text, whitespace collapsed, up to 150 characters. */
  preview: string | null;
  parentSessionId?: string;
}

export interface SessionDiscoveryConfig<TMsg = unknown> {
  storageRoot: string;
  projectId: string;
  /** Needed for previews and content search; without it, previews are null and search matches titles only. */
  accessor?: Pick<MessageAccessor<TMsg>, "getOrigin" | "toText">;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SessionErrorCode =
  | "invalid_project_id" // projectId is not a single path segment
  | "invalid_header" // line 1 missing, not a session header, or bad version
  | "malformed_line" // unparseable line other than the last
  | "unsupported_version" // written by a newer engine
  | "missing_migration" // no migration from the file's version
  | "message_format_mismatch" // host format differs and no upgradeMessage was given
  | "entry_not_found" // fork target not in the session
  | "invalid_entry"; // appendEntry with a reserved type

export class SessionError extends Error {
  override readonly name = "SessionError";

  constructor(
    readonly code: SessionErrorCode,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? code, options);
  }
}
