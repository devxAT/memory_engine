# Session Manager Architecture & Implementation Specification

This document provides the complete technical specification for the session persistence, forking, discovery, and migration subsystem in `memory_engine`. It is designed so that an engineering agent can implement all components directly.

- Rationale and comparative research: [docs/session.md](../docs/session.md)
- Context compaction specification: [architecture/compaction.md](compaction.md)
- Cross-session memory specification: [architecture/memory.md](memory.md)

---

## 1. Subsystem Overview & Directory Structure

The session subsystem lives under `src/session/`:

```
src/session/
├── types.ts                    # SessionHeader, SessionEntry, SessionConfig, SessionSummary, errors
├── migrations.ts               # Migration registry, version upgrading pipeline
├── store.ts                    # Low-level JSONL file append, read, and write primitives
├── discovery.ts                # Session discovery: list, search, delete, findMostRecent
├── manager.ts                  # SessionManager<TMsg> facade: entry appending, delayed flush, forking
└── index.ts                    # Public exports for the session module
```

### Design Rules
1. **Generic over Host Message Type (`TMsg`)**: `SessionManager<TMsg>` stores host messages as-is without inspecting, mutating, or converting them.
2. **Crash-Resilient Append-Only JSONL**: All entries are stored sequentially as JSON lines. Each line is an independent JSON object.
3. **Claude-Style File Forking**: Each `.jsonl` file represents a single conversation timeline. Branching creates a new self-contained session file that links to its parent via `parentSessionId`.
4. **Delayed Disk Flush**: Fresh sessions are held in memory and only written to disk upon completion of the first model assistant turn, preventing abandoned or empty session clutter.
5. **Zero SDK / Framework Coupling**: The manager requires only standard Node.js filesystem APIs (`node:fs`, `node:path`, `node:crypto`).

---

## 2. File Format & Schema Specification

Every session file is saved as an append-only JSONL file with the naming convention:
```
<timestamp>_<sessionId>.jsonl
```
*(e.g., `2026-10-31T20-45-12-345Z_a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl`)*

### 2.1 Line 1: `SessionHeader`

The first line of every valid session file must be a `SessionHeader` object:

```typescript
export interface SessionHeader {
  type: "session";
  /** Schema version, starting at 1. */
  version: number;
  /** Unique session UUID. */
  id: string;
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /** Working directory of the workspace. */
  cwd: string;
  /** Human-readable session title (set via /rename or auto-generated). */
  title?: string;
  /** If this session was forked, the UUID of the parent session. */
  parentSessionId?: string;
  /** If forked, the ID of the entry at which the fork occurred. */
  forkedFromEntryId?: string;
  /** Host-defined arbitrary metadata (e.g. git branch, model name, agent role). */
  metadata?: Record<string, unknown>;
}
```

### 2.2 Subsequent Lines: `SessionEntry<TMsg>`

All subsequent lines represent session entries conforming to `SessionEntryBase` (defined in `src/compaction/types.ts`):

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

Entries written to the file may include:
- `MessageEntry<TMsg>`: Human prompts, model completions, tool calls/results.
- `CompactionEntry`: Checkpoints produced by `CompactionEngine`.
- `PruneEntry`: Micro-pruning decisions produced by `CompactionEngine`.
- `CustomEntry`: Arbitrary host-specific events (e.g., bookmarks, model changes, notes).

---

## 3. Migration Framework (`src/session/migrations.ts`)

To ensure backward compatibility as the schema evolves, session files declare their schema version in the header (`version: 1`).

### 3.1 Migration Interface

```typescript
export interface Migration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (entries: unknown[]) => unknown[];
}
```

### 3.2 Current Version & Migration Runner

The canonical version is exported as a constant:
```typescript
export const CURRENT_SESSION_VERSION = 1;
```

When reading a session file:
1. Parse all non-empty JSON lines into an untyped array `unknown[]`.
2. Inspect the first entry:
   - If missing or not an object, throw `InvalidSessionFileError`.
   - If `entry.type !== "session"`, it is treated as a **legacy v0 format** (e.g., flat message list without a header).
   - If `entry.type === "session"`, extract `entry.version ?? 0`.
3. Check `fileVersion < CURRENT_SESSION_VERSION`:
   - Sequentially apply registered migrations `fromVersion -> toVersion`.
   - If any migration modifies the entries, the file can be optionally rewritten on disk.

```typescript
export class MigrationRegistry {
  private migrations: Migration[] = [];

  register(migration: Migration): void {
    this.migrations.push(migration);
  }

  migrate(entries: unknown[]): { entries: unknown[]; migrated: boolean } {
    if (entries.length === 0) return { entries, migrated: false };
    
    let header = entries[0] as Record<string, unknown>;
    let currentVersion = typeof header?.version === "number" ? header.version : 0;
    
    if (currentVersion >= CURRENT_SESSION_VERSION) {
      return { entries, migrated: false };
    }

    let modified = false;
    for (const m of this.migrations) {
      if (m.fromVersion === currentVersion) {
        entries = m.migrate(entries);
        currentVersion = m.toVersion;
        modified = true;
      }
    }

    return { entries, migrated: modified };
  }
}
```

---

## 4. Session Manager Lifecycle & Delayed Flush (`src/session/manager.ts`)

### 4.1 State Machine

```
              ┌───────────────┐
              │  newSession() │
              └───────┬───────┘
                      │
                      ▼
             ┌─────────────────┐
             │    UNFLUSHED    │ (Entries held in memory;
             │ (In-memory buf) │  no file on disk yet)
             └────────┬────────┘
                      │
     First completed assistant message
     OR explicit flush() called
                      │
                      ▼
             ┌─────────────────┐
             │     FLUSHED     │ (File created on disk;
             │  (Append-only)  │  subsequent entries appended)
             └─────────────────┘
```

### 4.2 Delayed Flush Mechanics

1. **Initialization**: When `new SessionManager(config)` is called without an existing file, it creates an initial `SessionHeader` in memory, generates a UUID, but **does not create a file on disk**.
2. **Buffering**: User messages, tool calls, and initial harness events are pushed to an in-memory `entryBuffer`.
3. **Flush Trigger**:
   - The host calls `sessionManager.appendMessage(msg)`.
   - When the host signals that the model's first response has finished (or `msg` is an assistant message), the manager triggers `_flushToDisk()`.
   - `_flushToDisk()` creates parent directories, opens the file, and writes all buffered entries atomically (`writeFileSync`).
4. **Append Phase**: Once flushed, all subsequent entries are appended directly to disk (`appendFileSync`).
5. **In-Memory Sessions**: If `config.persist === false`, entries are stored entirely in memory and disk I/O is skipped.

---

## 5. Claude-Style File Branching / Forking

Rather than mutating a shared session file or managing complex in-file DAG pointers, branching creates an independent, isolated session file:

```typescript
export interface ForkOptions {
  /** Optional custom title for the forked session. */
  title?: string;
  /** Working directory override if different from parent. */
  cwd?: string;
  /** Custom metadata additions for the forked session. */
  metadata?: Record<string, unknown>;
}
```

### 5.1 Forking Workflow
1. The developer or agent calls:
   ```typescript
   const branchedSession = await sessionManager.fork(targetEntryId, options);
   ```
2. If `targetEntryId` is omitted, the fork point defaults to the latest entry.
3. The manager extracts the slice of entries from the root up to and including `targetEntryId`.
4. It creates a new `SessionManager<TMsg>` instance with:
   - A fresh `sessionId`.
   - `parentSessionId: originalSession.id`.
   - `forkedFromEntryId: targetEntryId`.
   - The copied historical entries written to the new `.jsonl` file.
5. The original session is left intact. The returned `branchedSession` is immediately active and ready for new turns.

---

## 6. Standalone Session Discovery (`src/session/discovery.ts`)

Session discovery operates as static/standalone utility functions that do not require instantiating a full `SessionManager`:

```typescript
export interface SessionSummary {
  id: string;
  path: string;
  title: string | null;
  created: Date;
  modified: Date;
  entryCount: number;
  preview: string; // First user prompt snippet (up to 150 chars)
  parentSessionId?: string;
}

export interface SessionDiscoveryConfig {
  storageRoot: string;
  projectId: string;
}
```

### 6.1 Discovery Functions

- **`listSessions(config: SessionDiscoveryConfig): Promise<SessionSummary[]>`**:
  - Scans directory `<storageRoot>/<projectId>/`.
  - Reads line 1 (`SessionHeader`) and line 2 (first user message) using a partial buffered read without parsing entire large files.
  - Returns summaries sorted by `modified` date descending.

- **`searchSessions(config: SessionDiscoveryConfig, query: string): Promise<SessionSummary[]>`**:
  - Performs case-insensitive search across transcripts.
  - Matches either session titles or message content.

- **`deleteSession(config: SessionDiscoveryConfig, sessionId: string): Promise<boolean>`**:
  - Resolves file by UUID and safely removes it.

- **`findMostRecent(config: SessionDiscoveryConfig): Promise<string | null>`**:
  - Returns the file path of the most recently modified valid session, powering `--continue`.

- **`renameSession(sessionFilePath: string, newTitle: string): Promise<void>`**:
  - Updates the `title` field in the session's first line while preserving all subsequent entries.

---

## 7. Public API: `SessionManager<TMsg>` (`src/session/manager.ts`)

```typescript
export interface SessionConfig {
  /** Directory where session files are stored. */
  storageRoot: string;
  /** Project identifier or sanitized directory slug. */
  projectId: string;
  /** Whether to write to disk. Set false for ephemeral/test runs. Defaults to true. */
  persist?: boolean;
  /** Explicit session file to resume. If omitted, starts a new session. */
  sessionFile?: string;
  /** Working directory of the workspace. */
  cwd: string;
  /** Initial title if creating a new session. */
  title?: string;
  /** Host-supplied metadata. */
  metadata?: Record<string, unknown>;
}

export class SessionManager<TMsg> {
  constructor(config: SessionConfig);

  /** Session metadata accessors */
  getId(): string;
  getTitle(): string | undefined;
  setTitle(title: string): Promise<void>;
  getSessionFile(): string | undefined;
  getEntries(): SessionEntry<TMsg>[];
  getLeafEntry(): SessionEntry<TMsg> | undefined;

  /** Appending entries */
  appendMessage(message: TMsg, isCompletion?: boolean): MessageEntry<TMsg>;
  appendEntry<E extends SessionEntryBase>(entry: NewEntry<E>): E;

  /** Lineage and branching */
  fork(targetEntryId?: string, options?: ForkOptions): Promise<SessionManager<TMsg>>;

  /** Explicit flush (forces buffered entries to disk) */
  flush(): void;
}
```
