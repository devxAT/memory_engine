# Session Manager Architecture & Implementation Specification

This document provides the complete technical specification for the session persistence, forking, discovery, and migration subsystem in `memory_engine`. It is designed so that an engineering agent can implement all components directly.

- Rationale and comparative research: [docs/session.md](../docs/session.md)
- Revision history of this spec: [docs/session-changes.md](../docs/session-changes.md)
- Context compaction specification: [architecture/compaction.md](compaction.md)
- Cross-session memory specification: [architecture/memory.md](memory.md)

---

## 1. Subsystem Overview & Directory Structure

The session subsystem lives under `src/session/`:

```
src/session/
├── types.ts                    # SessionHeader, TitleEntry, CustomEntry, configs, SessionSummary, SessionError
├── paths.ts                    # Storage layout: project/session directories, file names, projectId validation
├── store.ts                    # JSONL primitives: parse (torn last line tolerated), create, append, atomic rewrite
├── migrations.ts               # Built-in schema migrations and the migration runner
├── discovery.ts                # listSessions, searchSessions, findMostRecent, deleteSession, renameSession
└── manager.ts                  # SessionManager<TMsg>: create/open, appending, delayed flush, forking
```

Like compaction, the module has no `index.ts`; `src/index.ts` re-exports each file.

### Design Rules
1. **Generic over Host Message Type (`TMsg`)**: `SessionManager<TMsg>` stores host messages as-is without inspecting, mutating, or converting them. It reads a message only through an optional, host-supplied `MessageAccessor` (flush trigger, discovery previews).
2. **One Linear Timeline per File**: File order is the conversation path. Each entry's `parentId` is the previous entry's `id` (`null` for the first entry). `getEntries()` is the root → leaf `path` that `CompactionEngine` takes.
3. **Append-Only JSONL**: Each line is an independent JSON object. Existing lines are never edited. The only full rewrite is persisting a migration (§3.3), done through a temp file and rename.
4. **Claude-Style File Forking**: Branching creates a new self-contained session file that links to its parent via `parentSessionId`. Rewinding to an earlier message is a fork.
5. **Delayed Disk Flush**: Fresh sessions are held in memory and only written to disk once the first model message is appended, preventing abandoned or empty session clutter.
6. **Single Writer**: One `SessionManager` writes a given session file at a time. There is no locking in v1; two writers interleave lines and break rule 2.
7. **Synchronous Manager, Asynchronous Discovery**: Manager I/O is synchronous, so file order always equals call order without a write queue. Discovery scans many files and is asynchronous.
8. **Zero SDK / Framework Coupling**: Only Node.js built-ins (`node:fs`, `node:path`, `node:crypto`, `node:os`). The clock and ID generator are injectable so tests stay deterministic.

---

## 2. Storage Layout & File Format

### 2.1 Layout (`src/session/paths.ts`)

```
<storageRoot>/
└── <projectId>/
    ├── MEMORY.md                 # Cross-session memory (architecture/memory.md)
    └── sessions/
        └── <timestamp>_<sessionId>.jsonl
```

- `projectDir(storageRoot, projectId)` and `sessionsDir(storageRoot, projectId)` build these paths. `MemoryManager` uses `projectDir` too.
- `projectId` must be a single path segment: non-empty, no `/` or `\`, not `.` or `..`. Anything else throws `SessionError("invalid_project_id")`.
- `projectIdFromCwd(cwd)` derives a slug the way Claude Code does: the path with every character outside `[A-Za-z0-9]` replaced by `-` (e.g. `C:\dev\my_app` → `C--dev-my-app`). The path is used as given, not resolved, so the result is the same on every platform; hosts pass an absolute path such as `process.cwd()`. Slugs longer than 200 characters are cut to 200 and given a `-<8 hex chars>` suffix from a SHA-256 of the full path, keeping deep paths under OS path limits. Different paths can map to the same slug (`my_app` and `my-app`); hosts that care pass their own `projectId`.
- File name: `<timestamp>_<sessionId>.jsonl`, where `<timestamp>` is the header's `timestamp` with `:` and `.` replaced by `-` (valid on Windows; names sort chronologically). Example: `2026-10-31T20-45-12-345Z_a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl`.
- Files are UTF-8 with LF line endings, one `JSON.stringify` output per line.

### 2.2 Line 1: `SessionHeader`

The first line of every valid session file must be a `SessionHeader`. It is written once and never edited, except by a migration rewrite (§3.3).

```typescript
export interface SessionHeader {
  type: "session";
  /** Engine schema version; `CURRENT_SESSION_VERSION` when written. */
  version: number;
  /** Unique session UUID. */
  id: string;
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /** Working directory of the workspace. */
  cwd: string;
  /** Host message format and version, opaque to the engine (e.g. "my-agent/messages@3"). See §3.2. */
  messageFormat?: string;
  /** Initial title. Later renames are `title` entries (§2.3). */
  title?: string;
  /** If this session was forked, the UUID of the parent session. */
  parentSessionId?: string;
  /** If forked, the ID of the entry at which the fork occurred. */
  forkedFromEntryId?: string;
  /** Host-defined arbitrary metadata (e.g. git branch, model name, agent role). */
  metadata?: Record<string, unknown>;
}
```

### 2.3 Subsequent Lines: Entries

All subsequent lines are `SessionEntry<TMsg>` objects. The base types are defined in `src/compaction/types.ts`:

```typescript
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

export interface MessageEntry<TMsg> extends SessionEntryBase {
  type: "message";
  message: TMsg;
}
```

The manager assigns `id` (`generateId`, default `crypto.randomUUID()`), `parentId` (the previous entry's `id`, or `null`), and `timestamp` (`now().toISOString()`).

| `type` | Defined in | Written by |
| :--- | :--- | :--- |
| `message` | `compaction/types.ts` | `appendMessage` |
| `prune` | `compaction/types.ts` | host appends `CompactionEngine.planMicro` output |
| `compaction` | `compaction/types.ts` | host appends `CompactionEngine.compact` output |
| `title` | `session/types.ts` | `setTitle` |
| `custom` | `session/types.ts` | host, via `appendEntry` |

Every other `type` value is reserved for the engine. Host-specific events (bookmarks, model changes, notes) use `custom`, so a future engine entry type never collides with a host's.

```typescript
export interface TitleEntry extends SessionEntryBase {
  type: "title";
  title: string;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  /** Host-defined event name, e.g. "bookmark" or "model_change". */
  customType: string;
  data?: T;
}
```

The **effective title** is the `title` of the last `TitleEntry`, or else `header.title` (`effectiveTitle(header, entries)`). The guards `isTitleEntry` and `isCustomEntry` narrow entries; they accept any `{ type: string }`, because interfaces are not assignable to the catch-all member of `SessionEntry`.

### 2.4 Reading a File (`src/session/store.ts`)

1. Read the file as UTF-8, split on `\n`, and skip empty lines.
2. `JSON.parse` each line:
   - A malformed **last** line is a torn write from a crash. It is dropped. A manager that opens the file for writing truncates the file to the end of the last valid line before its first append; otherwise the next entry would be glued onto the broken line.
   - A malformed line anywhere else throws `SessionError("malformed_line")` with the 1-based line number.
3. Line 1 must be an object with `type: "session"`; otherwise (including an empty file) throw `SessionError("invalid_header")`. There is no headerless legacy format: this engine has never written one.
4. Run the migration runner (§3).

---

## 3. Migrations (`src/session/migrations.ts`)

Two things can change independently: the engine's file schema (`version`) and the host's message type (`messageFormat`). The engine migrates the first; the host migrates the second.

### 3.1 Engine Schema Migrations

```typescript
export const CURRENT_SESSION_VERSION = 1;

export interface Migration {
  /** Upgrades files at `fromVersion` to `fromVersion + 1`. */
  fromVersion: number;
  description: string;
  /** Receives line 1 (the header) followed by the entries; returns the upgraded lines. */
  migrate: (lines: unknown[]) => unknown[];
}

/** Engine-owned; empty at version 1. */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrateOptions {
  migrations?: readonly Migration[];   // default: MIGRATIONS
  currentVersion?: number;             // default: CURRENT_SESSION_VERSION
}

export function migrateSession(
  lines: unknown[],
  options?: MigrateOptions,
): { lines: unknown[]; migrated: boolean };
```

Runner:
1. `v = header.version`. If it is not a positive integer, throw `invalid_header`.
2. If `v > CURRENT_SESSION_VERSION`, throw `unsupported_version`. The file was written by a newer engine; appending old-format entries to it would corrupt it.
3. While `v < CURRENT_SESSION_VERSION`: find the migration with `fromVersion === v` (none → throw `missing_migration`), apply it, increment `v`, and set `header.version = v`. Migrations do not set the version themselves.
4. Return `migrated: true` if any step ran.

The migration list is a built-in constant, not a public registry: only the engine knows how to upgrade its own schema. `MigrateOptions` exists so tests can exercise the runner while `MIGRATIONS` is empty and the current version is 1.

### 3.2 Host Message Format

- `SessionConfig.messageFormat` is recorded in the header of new sessions.
- `OpenOptions.messageFormat`, when set, is compared with the header's. On a mismatch:
  - with `OpenOptions.upgradeMessage`, every message entry's `message` is replaced by `upgradeMessage(message, header.messageFormat)`, and `header.messageFormat` is updated. This counts as a migration.
  - without it, throw `SessionError("message_format_mismatch")`.
- When `OpenOptions.messageFormat` is unset, no check is made.

### 3.3 Persisting a Migration

If any migration ran (schema or message format) and the session is opened with `persist: true`, `open` rewrites the file before returning: all lines are written to `<file>.tmp`, which is then renamed over the original. This must happen before any append. Otherwise current-format entries would be appended to a file whose header still names the old version, and the next load would "migrate" them a second time.

Discovery (§6) migrates in memory only and never writes.

---

## 4. Session Manager Lifecycle & Delayed Flush (`src/session/manager.ts`)

### 4.1 Creating and Opening

```typescript
const session = SessionManager.create<Msg>(config);     // new session, in memory until flushed
const resumed = SessionManager.open<Msg>(file, options); // existing file
```

Creating and resuming are separate factories rather than one constructor that branches on an optional `sessionFile`: they take different inputs (a resumed session takes `cwd`, title, and metadata from its header), and opening does file I/O, which a constructor should not hide.

### 4.2 State Machine

```
   SessionManager.create()                    SessionManager.open(file)
              │                                          │
              ▼                                          │
     ┌─────────────────┐                                 │
     │    UNFLUSHED    │ (Header and entries in memory;  │
     │ (In-memory buf) │  no file on disk yet)           │
     └────────┬────────┘                                 │
              │                                          │
   First model message appended                          │
   (needs config.accessor)                               │
   OR flush() called                                     │
              │                                          │
              ▼                                          ▼
     ┌─────────────────────────────────────────────────────┐
     │                       FLUSHED                       │
     │   (File on disk; each new entry appended at once)   │
     └─────────────────────────────────────────────────────┘
```

With `persist: false`, the session never touches the disk (§4.4).

### 4.3 Delayed Flush Mechanics

1. **Creation**: `create(config)` builds the header in memory with a fresh UUID. No file is created. The file path is already fixed (§2.1) and returned by `getSessionFile()`.
2. **Buffering**: Appended entries (user messages, harness events, custom entries) stay in memory.
3. **Flush trigger**:
   - When `config.accessor` is given, appending a message for which `accessor.getOrigin(message) === "model"` flushes. The host appends a model message only once it is complete (entries are never updated), so "appended" means "completed".
   - `flush()` always flushes.
   - Without an accessor, only `flush()` flushes. The manager never inspects messages on its own.
4. **Flush**: create the sessions directory, then write the header and all buffered entries with a single `writeFileSync(file, data, { flag: "wx" })`. `wx` fails if the file already exists, so a flush never overwrites another session. The write is not atomic; a crash mid-write leaves a torn last line, which §2.4 handles. If the flush throws, the session stays UNFLUSHED with the entry buffered, and the next append or `flush()` retries.
5. **Append phase**: once flushed, each entry is written with `appendFileSync` **before** it is added to memory. If the write throws, the error reaches the host and memory still matches the disk.
6. **Known trade-off**: a crash before the first flush loses the buffered entries, typically the first prompt.

### 4.4 In-Memory Sessions

With `persist: false`, nothing is ever written: `flush()` is a no-op, `getSessionFile()` returns `undefined` for created sessions, and forks are in-memory too. `open(file, { persist: false })` reads the file but keeps new entries in memory and never rewrites, truncates, or appends.

---

## 5. Claude-Style File Branching / Forking

Rather than mutating a shared session file or managing complex in-file DAG pointers, branching creates an independent, isolated session file:

```typescript
export interface ForkOptions {
  /** Title for the fork. Default: the parent's title at the fork point. */
  title?: string;
  /** Working directory override. Default: the parent's. */
  cwd?: string;
  /** Shallow-merged over the parent's metadata. */
  metadata?: Record<string, unknown>;
}
```

### 5.1 Forking Workflow
1. The host calls:
   ```typescript
   const branchedSession = sessionManager.fork(targetEntryId, options);
   ```
2. If `targetEntryId` is omitted, the fork point is the leaf (this duplicates the session). An unknown ID, or a session without entries, throws `SessionError("entry_not_found")`.
3. If the parent is persisted but not yet flushed, it is flushed first, so the child's `parentSessionId` names a file that exists.
4. The child header gets a fresh `id` and `timestamp`, `parentSessionId: parent.id`, `forkedFromEntryId: targetEntryId`, `cwd: options.cwd ?? parent.cwd`, the parent's `messageFormat` and `title`, and `metadata: { ...parent.metadata, ...options.metadata }`.
5. The entries from the first through `targetEntryId` are copied **verbatim**, keeping their `id`, `parentId`, and `timestamp`. IDs must survive: copied compaction entries point at earlier entries through `firstKeptEntryId`, and `forkedFromEntryId` must name an entry that exists in both files.
6. If `options.title` is given, a `TitleEntry` is appended after the copied entries.
7. The child has the parent's persistence. When persisted, it is written immediately (header plus copied entries): a fork is an explicit request, and its history normally already contains the completed reply the delayed flush waits for.
8. The parent is left intact. The child is self-contained: deleting either file never breaks the other.

### 5.2 Choosing a Fork Point
The manager does not inspect messages, so it cannot tell whether a fork point ends a complete exchange. Forking right after a model message with unanswered tool calls produces a session whose next request contains a dangling call. Hosts fork at a human message (to rewind and re-prompt) or at a model message without pending tool calls.

---

## 6. Standalone Session Discovery (`src/session/discovery.ts`)

Session discovery operates as standalone functions that do not require instantiating a `SessionManager`:

```typescript
export interface SessionSummary {
  id: string;
  path: string;
  /** Effective title (§2.3), or null. */
  title: string | null;
  cwd: string;
  /** Header timestamp. */
  created: Date;
  /** Timestamp of the last entry (the header's if none). Unlike file mtime, it survives copies and syncs. */
  modified: Date;
  /** Number of message entries. */
  messageCount: number;
  /** Text of the first human message that has text, whitespace collapsed, up to 150 chars. Null without an accessor. */
  preview: string | null;
  parentSessionId?: string;
}

export interface SessionDiscoveryConfig<TMsg = unknown> {
  storageRoot: string;
  projectId: string;
  /** Needed for previews and content search. Without it, previews are null and search matches titles only. */
  accessor?: Pick<MessageAccessor<TMsg>, "getOrigin" | "toText">;
}
```

### 6.1 Discovery Functions

- **`listSessions(config): Promise<SessionSummary[]>`**:
  - Reads every `*.jsonl` file in `<storageRoot>/<projectId>/sessions/` in full. The title, `modified`, and `messageCount` can be anywhere in the file, so a header-only read is not enough.
  - Skips files without a valid header instead of throwing. Torn last lines are ignored; migrations run in memory only.
  - Returns summaries sorted by `modified` descending.
  - A full scan is fine for tens to hundreds of sessions per project. A catalog/index (like Codex's SQLite state database) is an open point if listing gets slow.

- **`searchSessions(config, query): Promise<SessionSummary[]>`**:
  - Case-insensitive substring match against the effective title and, with an accessor, `accessor.toText` of every message entry.
  - Returns matches in `listSessions` order.

- **`findMostRecent(config): Promise<string | null>`**:
  - Returns the path of the first `listSessions` result, powering `--continue`.

- **`deleteSession(config, sessionId): Promise<boolean>`**:
  - Finds the file in the directory listing whose name parses to `sessionId` (`sessionIdFromFileName`: everything between the first `_` and `.jsonl`; a path is never built from the raw ID) and removes it. Exact parsing, not a suffix match, so an ID never matches a longer one that ends with it. Returns `false` if none matches. Forks of the deleted session keep working.

- **`renameSession(file, title): void`**:
  - Shorthand for `SessionManager.open(file).setTitle(title)`. Synchronous, like the manager. Do not use it on a session that another manager has open (§1, rule 6).

A missing sessions directory yields `[]`, `null`, or `false`, not an error. Every function validates `projectId` (§2.1).

---

## 7. Public API: `SessionManager<TMsg>` (`src/session/manager.ts`)

```typescript
export interface SessionConfig<TMsg> {
  /** Directory where all projects are stored. */
  storageRoot: string;
  /** Project identifier: a single path segment (see `projectIdFromCwd`). */
  projectId: string;
  /** Working directory of the workspace. */
  cwd: string;
  /** Whether to write to disk. Set false for ephemeral/test runs. Defaults to true. */
  persist?: boolean;
  /** Initial title. */
  title?: string;
  /** Host-supplied metadata. */
  metadata?: Record<string, unknown>;
  /** Host message format, recorded in the header (§3.2). */
  messageFormat?: string;
  /** When given, the first model message triggers the flush (§4.3). */
  accessor?: Pick<MessageAccessor<TMsg>, "getOrigin">;
  /** Defaults: `crypto.randomUUID` and `() => new Date()`. */
  generateId?: () => string;
  now?: () => Date;
}

export interface OpenOptions<TMsg> {
  /** Defaults to true. False: read the file, keep new entries in memory, never write. */
  persist?: boolean;
  /** Expected host message format (§3.2). */
  messageFormat?: string;
  upgradeMessage?: (message: unknown, fromFormat: string | undefined) => TMsg;
  generateId?: () => string;
  now?: () => Date;
}

export class SessionManager<TMsg> {
  static create<TMsg>(config: SessionConfig<TMsg>): SessionManager<TMsg>;
  static open<TMsg>(file: string, options?: OpenOptions<TMsg>): SessionManager<TMsg>;

  /** Session metadata accessors */
  getId(): string;
  getHeader(): Readonly<SessionHeader>;
  /** Effective title (§2.3). */
  getTitle(): string | undefined;
  /** Appends a `TitleEntry`. */
  setTitle(title: string): TitleEntry;
  /** Fixed at creation; `undefined` only for in-memory sessions. */
  getSessionFile(): string | undefined;
  isFlushed(): boolean;
  /** Root → leaf, header excluded: the `path` CompactionEngine takes. Returns a shallow copy. */
  getEntries(): SessionEntry<TMsg>[];
  getLeafEntry(): SessionEntry<TMsg> | undefined;

  /** Appending entries */
  appendMessage(message: TMsg): MessageEntry<TMsg>;
  /**
   * Engine output (`prune`, `compaction`) and `custom` entries. `message` and `title` entries
   * go through their own methods; those types, and `session`, throw `invalid_entry` here.
   */
  appendEntry<E extends { type: string }>(entry: E): E & SessionEntryBase;

  /** Lineage and branching (§5) */
  fork(targetEntryId?: string, options?: ForkOptions): SessionManager<TMsg>;

  /** Explicit flush (forces buffered entries to disk); no-op when flushed or in memory */
  flush(): void;
}
```

`appendEntry` takes the entry type as its own type parameter, so both `appendEntry(outcome.entry)` and an object literal such as `appendEntry({ type: "custom", customType: "bookmark", data })` return their full shape plus the base fields. A signature written as `appendEntry<E extends SessionEntryBase>(entry: NewEntry<E>): E` infers `E` only when the argument is already typed `NewEntry<X>`; for an object literal it falls back to `SessionEntryBase`.

---

## 8. Integration with `CompactionEngine`

A session file holds one timeline, so `getEntries()` is the compaction `path` with no resolution step:

```typescript
async function runModelRequest(session: SessionManager<Msg>, engine: CompactionEngine<Msg>, budget: ModelBudget) {
  const prune = engine.planMicro(session.getEntries(), budget);
  if (prune) session.appendEntry(prune);

  if (engine.shouldCompact(session.getEntries(), budget)) {
    const outcome = await engine.compact(session.getEntries(), budget, { reason: "threshold" });
    if (outcome.status === "compacted") session.appendEntry(outcome.entry);
  }

  const reply = await callModel(engine.buildContext(session.getEntries())); // overflow retry: compaction §10
  session.appendMessage(reply); // the first model reply flushes a new session
  return reply;
}
```

Memory text injected into the system prompt (`MemoryManager.readMemory`) is not stored in the session. On the heuristic measurement path, hosts count it in `ModelBudget.overheadTokens`.

---

## 9. Errors (`src/session/types.ts`)

```typescript
export type SessionErrorCode =
  | "invalid_project_id"       // projectId is not a single path segment
  | "invalid_header"           // line 1 missing, not a session header, or bad version
  | "malformed_line"           // unparseable line other than the last
  | "unsupported_version"      // written by a newer engine
  | "missing_migration"        // no migration from the file's version
  | "message_format_mismatch"  // host format differs and no upgradeMessage was given
  | "entry_not_found"          // fork target not in the session
  | "invalid_entry";           // appendEntry with a reserved type

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
```

The message includes the file path and, for `malformed_line`, the line number.

---

## 10. Storage Format Example

A session that was renamed once:

```jsonl
{"type":"session","version":1,"id":"5f0c9a2e-1b7d-4c3a-9e61-2d8f0b4a7c15","timestamp":"2026-10-31T20:45:12.345Z","cwd":"/work/app","messageFormat":"my-agent/messages@3"}
{"type":"message","id":"8d1e…","parentId":null,"timestamp":"2026-10-31T20:45:12.350Z","message":{"…":"host's own message format"}}
{"type":"message","id":"c47a…","parentId":"8d1e…","timestamp":"2026-10-31T20:45:20.101Z","message":{"…":"…"}}
{"type":"title","id":"e902…","parentId":"c47a…","timestamp":"2026-10-31T20:46:03.000Z","title":"Fix login redirect"}
```

The header of a fork taken at `c47a…`, followed by verbatim copies of the first two message entries:

```jsonl
{"type":"session","version":1,"id":"0b6f…","timestamp":"2026-10-31T21:02:40.000Z","cwd":"/work/app","messageFormat":"my-agent/messages@3","parentSessionId":"5f0c9a2e-1b7d-4c3a-9e61-2d8f0b4a7c15","forkedFromEntryId":"c47a…"}
```

---

## 11. Agent Implementation Guide

Build in this order. Tests use a fresh temporary directory per test (`fs.mkdtempSync(path.join(os.tmpdir(), …))`), a fixed clock, and counter-based IDs.

1. **Types** (`types.ts`): header, `TitleEntry`, `CustomEntry`, configs, `SessionSummary`, `SessionError`.
2. **Paths** (`paths.ts`): `projectId` validation, `projectIdFromCwd` (Windows and POSIX paths), file names.
3. **Store** (`store.ts`): parse (torn last line dropped, malformed middle line rejected, missing header, empty file), exclusive create, append, atomic rewrite, torn-tail truncation.
4. **Migrations** (`migrations.ts`): runner with test-only migrations: sequential steps, missing step, newer-version file, version updated by the runner.
5. **Manager** (`manager.ts`): delayed flush (accessor trigger, explicit flush, no trigger without accessor, failed flush retried), write-before-commit, titles, message format upgrade and rewrite, reopen round-trip, in-memory mode.
6. **Fork**: IDs preserved, unflushed parent flushed first, title and metadata inheritance, fork of an in-memory session.
7. **Discovery** (`discovery.ts`): invalid files skipped, previews with and without accessor, sort order, search, `findMostRecent`, delete via directory listing, rename.
8. **Integration**: `CompactionEngine` driven by a `SessionManager`; reopen and rebuild the same context; fork a compacted session and build its context.
