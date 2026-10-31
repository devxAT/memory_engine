# Cross-Session Memory Architecture & Implementation Specification

This document provides the complete technical specification for the cross-session memory subsystem (`MemoryManager`) in `memory_engine`. It is designed so that an engineering agent can implement all components directly.

- Rationale and comparative research: [docs/session.md](../docs/session.md)
- Session persistence specification: [architecture/session.md](session.md)
- Context compaction specification: [architecture/compaction.md](compaction.md)

---

## 1. Subsystem Overview & Directory Structure

The cross-session memory subsystem lives under `src/memory/`:

```
src/memory/
├── types.ts                    # MemoryConfig, ReadMemoryOptions, MemoryNote
├── manager.ts                  # MemoryManager class implementation
└── index.ts                    # Public exports
```

### Design Rules
1. **Decoupled from Conversation Transcripts**: Transcripts record chronological dialogue; `MemoryManager` records project conventions, user directives, and architectural decisions that survive across sessions.
2. **Progressive Disclosure & Context Budgeting**: Unbounded memory injection leads to prompt window bloat. `MemoryManager` enforces a configurable budget (defaulting to the first 200 lines or 25KB, matching Claude Code's pattern) for initial prompt injection.
3. **Transparent Markdown Storage**: Stored as standard human-readable Markdown (`MEMORY.md`) within the project namespace directory. Developers can inspect, edit, or commit it directly.
4. **Structured Note Appending**: Supports programmatic note updates under clear category headers (`Conventions`, `Architecture`, `User Preferences`, `Build & Test`).
5. **No Runtime Dependencies**: Uses Node.js built-ins (`node:fs`, `node:path`).

---

## 2. Storage Layout

The `MEMORY.md` file is stored per project under the designated storage root:
```
<storageRoot>/
└── <projectId>/
    ├── MEMORY.md                 # Project-level persistent memory
    └── sessions/                 # Active session JSONL files
```

### Default File Structure (`MEMORY.md`)
```markdown
# Project Memory

## Conventions & Rules
- Always use pnpm for package management.
- Unit tests run via `npm run test -- <pattern>`.

## Architecture Decisions
- Context compaction uses two tiers: micro-pruning followed by rolling-delta macro summarization.

## User Preferences
- Prefer concise, technical explanations without filler phrases.
```

---

## 3. Core Types (`src/memory/types.ts`)

```typescript
export interface MemoryConfig {
  /** Root directory for agent storage. */
  storageRoot: string;
  /** Project identifier or sanitized directory slug. */
  projectId: string;
  /** Custom filename, defaults to "MEMORY.md". */
  fileName?: string;
  /** Default maximum lines to load into initial prompt context (default: 200). */
  maxContextLines?: number;
  /** Default maximum characters to load into initial prompt context (default: 25,000). */
  maxContextChars?: number;
}

export interface ReadMemoryOptions {
  /** Maximum lines to read from the top of the file. */
  maxLines?: number;
  /** Maximum characters to return. */
  maxChars?: number;
  /** If true, returns null if the file does not exist rather than throwing. Defaults to true. */
  silent?: boolean;
}

export type MemoryCategory =
  | "Conventions"
  | "Architecture"
  | "Preferences"
  | "Environment"
  | (string & {});

export interface MemoryNote {
  category: MemoryCategory;
  content: string;
  timestamp?: string;
}
```

---

## 4. Public API: `MemoryManager` (`src/memory/manager.ts`)

```typescript
export class MemoryManager {
  readonly filePath: string;
  private readonly maxContextLines: number;
  private readonly maxContextChars: number;

  constructor(config: MemoryConfig);

  /**
   * Reads memory content formatted for injection into the agent's system prompt.
   * Automatically truncates to the configured line/character budget with a notice
   * if the file exceeds the budget.
   *
   * Returns null if no memory file exists yet.
   */
  readMemory(options?: ReadMemoryOptions): string | null;

  /**
   * Reads the entire, unbudgeted memory file.
   */
  readFullMemory(): string | null;

  /**
   * Completely overwrites the memory file with new Markdown content.
   * Creates parent directories if they do not exist.
   */
  writeMemory(content: string): void;

  /**
   * Appends a bulleted note under a specific Markdown heading (`## <category>`).
   * If the category heading does not exist, it is created.
   */
  appendNote(category: MemoryCategory, note: string): void;

  /**
   * Clears or deletes the project's MEMORY.md file.
   */
  clear(): void;

  /**
   * Returns true if a memory file exists on disk.
   */
  exists(): boolean;
}
```

---

## 5. Budgeting & Truncation Algorithm

When injecting into the agent's system prompt via `readMemory()`:
1. If the file does not exist or is empty, return `null`.
2. Read the raw text and split into lines.
3. Check against `maxLines` (default 200) and `maxChars` (default 25,000):
   - If both limits are satisfied, return the raw text unmodified.
   - If either limit is exceeded, slice up to the first violating limit.
   - Append a clear eviction footer:
     ```markdown
     [... remaining lines truncated to preserve context budget; view full MEMORY.md on disk ...]
     ```
4. This ensures that even if developers or agents write massive memory files, cold starts never exhaust prompt tokens.
