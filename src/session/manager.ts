import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MessageAccessor,
  MessageEntry,
  NewEntry,
  SessionEntry,
  SessionEntryBase,
} from "../compaction/types.js";
import { CURRENT_SESSION_VERSION, migrateSession } from "./migrations.js";
import { sessionFileName, sessionsDir } from "./paths.js";
import { appendLine, createFile, parseLines, repairTail, rewriteFile } from "./store.js";
import {
  effectiveTitle,
  type ForkOptions,
  type OpenOptions,
  type SessionConfig,
  SessionError,
  type SessionHeader,
  type TitleEntry,
} from "./types.js";

/** Types that have their own method (`message`, `title`) or are not entries at all. */
const RESERVED_TYPES = new Set(["session", "message", "title"]);

const isMessageLine = (line: unknown): line is { type: "message"; message: unknown } =>
  typeof line === "object" && line !== null && (line as { type?: unknown }).type === "message";

interface ManagerInit<TMsg> {
  header: SessionHeader;
  entries: SessionEntry<TMsg>[];
  file: string | undefined;
  persist: boolean;
  flushed: boolean;
  accessor: Pick<MessageAccessor<TMsg>, "getOrigin"> | undefined;
  generateId: () => string;
  now: () => Date;
}

/**
 * One session file: a header followed by a single linear timeline of entries, in file order.
 * A new session stays in memory until its first model message (or `flush()`); from then on,
 * each entry is appended to the file as it is added. One manager per file at a time.
 */
export class SessionManager<TMsg> {
  private readonly header: SessionHeader;
  private readonly entries: SessionEntry<TMsg>[];
  /** Where the session lives; undefined for sessions created in memory. */
  private readonly file: string | undefined;
  /** False: never write, even when `file` is set (opened with `persist: false`). */
  private readonly persist: boolean;
  /** Whether the file exists with every entry so far. */
  private flushed: boolean;
  private readonly accessor: Pick<MessageAccessor<TMsg>, "getOrigin"> | undefined;
  private readonly generateId: () => string;
  private readonly now: () => Date;

  private constructor(init: ManagerInit<TMsg>) {
    this.header = init.header;
    this.entries = init.entries;
    this.file = init.file;
    this.persist = init.persist;
    this.flushed = init.flushed;
    this.accessor = init.accessor;
    this.generateId = init.generateId;
    this.now = init.now;
  }

  /** A new session, held in memory until flushed. Its file path is fixed now. */
  static create<TMsg>(config: SessionConfig<TMsg>): SessionManager<TMsg> {
    const generateId = config.generateId ?? randomUUID;
    const now = config.now ?? (() => new Date());
    const dir = sessionsDir(config.storageRoot, config.projectId);
    const persist = config.persist ?? true;
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: generateId(),
      timestamp: now().toISOString(),
      cwd: config.cwd,
      messageFormat: config.messageFormat,
      title: config.title,
      metadata: config.metadata,
    };
    return new SessionManager({
      header,
      entries: [],
      file: persist ? join(dir, sessionFileName(header)) : undefined,
      persist,
      flushed: false,
      accessor: config.accessor,
      generateId,
      now,
    });
  }

  /**
   * An existing session file. Migrates it (schema version, and host message format when
   * `messageFormat` is given) and, when persisting, rewrites a migrated file or repairs a torn
   * tail before anything is appended.
   */
  static open<TMsg>(file: string, options: OpenOptions<TMsg> = {}): SessionManager<TMsg> {
    const persist = options.persist ?? true;
    const text = readFileSync(file, "utf8");
    const parsed = parseLines(text, file);
    let { lines, migrated } = migrateSession(parsed.lines);
    const header = lines[0] as SessionHeader;

    const { messageFormat, upgradeMessage } = options;
    if (messageFormat !== undefined && messageFormat !== header.messageFormat) {
      if (!upgradeMessage) {
        throw new SessionError(
          "message_format_mismatch",
          `${file}: message format ${JSON.stringify(header.messageFormat)}, expected ${JSON.stringify(messageFormat)}`,
        );
      }
      const from = header.messageFormat;
      lines = lines.map((line, i) =>
        i > 0 && isMessageLine(line)
          ? { ...line, message: upgradeMessage(line.message, from) }
          : line,
      );
      header.messageFormat = messageFormat;
      migrated = true;
    }

    if (persist) {
      // Rewrite before any append, or new entries would be migrated again on the next load.
      if (migrated) rewriteFile(file, lines);
      else repairTail(file, text, parsed);
    }

    return new SessionManager({
      header,
      entries: lines.slice(1) as SessionEntry<TMsg>[],
      file,
      persist,
      flushed: true,
      accessor: undefined,
      generateId: options.generateId ?? randomUUID,
      now: options.now ?? (() => new Date()),
    });
  }

  getId(): string {
    return this.header.id;
  }

  getHeader(): Readonly<SessionHeader> {
    return this.header;
  }

  /** The last `title` entry's title, or else the header's. */
  getTitle(): string | undefined {
    return effectiveTitle(this.header, this.entries);
  }

  setTitle(title: string): TitleEntry {
    return this.append<NewEntry<TitleEntry>>({ type: "title", title });
  }

  /** Fixed at creation; undefined only for sessions created in memory. */
  getSessionFile(): string | undefined {
    return this.file;
  }

  isFlushed(): boolean {
    return this.flushed;
  }

  /** Root → leaf, header excluded: the `path` that `CompactionEngine` takes. A shallow copy. */
  getEntries(): SessionEntry<TMsg>[] {
    return [...this.entries];
  }

  getLeafEntry(): SessionEntry<TMsg> | undefined {
    return this.entries.at(-1);
  }

  /** Flushes a new session when the message's origin is "model" and an accessor was given. */
  appendMessage(message: TMsg): MessageEntry<TMsg> {
    const entry = this.append<NewEntry<MessageEntry<TMsg>>>({ type: "message", message });
    if (!this.flushed && this.accessor?.getOrigin(message) === "model") this.flush();
    return entry;
  }

  /** Engine output (`prune`, `compaction`) and `custom` entries. */
  appendEntry<E extends { type: string }>(entry: E): E & SessionEntryBase {
    if (RESERVED_TYPES.has(entry.type)) {
      throw new SessionError(
        "invalid_entry",
        `"${entry.type}" entries cannot be appended directly`,
      );
    }
    return this.append(entry);
  }

  /**
   * A new session holding a verbatim copy of the entries up to `targetEntryId` (default: the
   * leaf), linked through `parentSessionId`. A persisted fork is written at once; an unflushed
   * parent is flushed first so the link names an existing file.
   */
  fork(targetEntryId?: string, options: ForkOptions = {}): SessionManager<TMsg> {
    const index =
      targetEntryId === undefined
        ? this.entries.length - 1
        : this.entries.findIndex((entry) => entry.id === targetEntryId);
    if (index < 0) {
      throw new SessionError(
        "entry_not_found",
        targetEntryId === undefined
          ? `Session ${this.header.id} has no entries to fork`
          : `Entry ${targetEntryId} is not in session ${this.header.id}`,
      );
    }
    this.flush();

    const parent = this.header;
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.generateId(),
      timestamp: this.now().toISOString(),
      cwd: options.cwd ?? parent.cwd,
      messageFormat: parent.messageFormat,
      title: parent.title,
      parentSessionId: parent.id,
      forkedFromEntryId: this.entries[index].id,
      metadata:
        parent.metadata || options.metadata
          ? { ...parent.metadata, ...options.metadata }
          : undefined,
    };
    const target = this.target;
    const child = new SessionManager<TMsg>({
      header,
      // IDs are kept: compaction entries refer to earlier entries by ID.
      entries: this.entries.slice(0, index + 1),
      file: target === undefined ? undefined : join(dirname(target), sessionFileName(header)),
      persist: this.persist,
      flushed: false,
      accessor: this.accessor,
      generateId: this.generateId,
      now: this.now,
    });
    if (options.title !== undefined) child.setTitle(options.title);
    child.flush();
    return child;
  }

  /**
   * Writes the header and buffered entries in one exclusive create. No-op once flushed or when
   * not persisting. On failure the session stays unflushed and the next flush retries.
   */
  flush(): void {
    const file = this.target;
    if (this.flushed || file === undefined) return;
    createFile(file, [this.header, ...this.entries]);
    this.flushed = true;
  }

  /** The file to write to, or undefined when this manager never writes. */
  private get target(): string | undefined {
    return this.persist ? this.file : undefined;
  }

  private append<E extends { type: string }>(fields: E): E & SessionEntryBase {
    const base: SessionEntryBase = {
      id: this.generateId(),
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: this.now().toISOString(),
    };
    // Base fields lead each line; the second copy overrides any the caller passed.
    const entry = Object.assign({ type: fields.type, ...base }, fields, base);
    const file = this.target;
    // Write before committing, so a failed write leaves memory matching the file.
    if (this.flushed && file !== undefined) appendLine(file, entry);
    this.entries.push(entry as unknown as SessionEntry<TMsg>);
    return entry;
  }
}
