# Cross-Session Memory Architecture & Implementation Specification

This document provides the complete technical specification for the cross-session memory subsystem (`MemoryManager`) in `memory_engine`. It is designed so that an engineering agent can implement all components directly.

- Rationale and comparative research: [docs/session.md](../docs/session.md)
- Revision history of this spec: [docs/session-changes.md](../docs/session-changes.md)
- Session persistence specification: [architecture/session.md](session.md)
- Context compaction specification: [architecture/compaction.md](compaction.md)

---

## 1. Subsystem Overview & Directory Structure

The cross-session memory subsystem lives under `src/memory/`:

```
src/memory/
├── types.ts                    # MemoryConfig, ReadMemoryOptions, MemoryCategory
└── manager.ts                  # MemoryManager class implementation
```

Like compaction and sessions, the module has no `index.ts`; `src/index.ts` re-exports each file.

### Design Rules
1. **Decoupled from Conversation Transcripts**: Transcripts record chronological dialogue; `MemoryManager` records project conventions, user directives, and architectural decisions that survive across sessions.
2. **Context Budgeting**: Unbounded memory injection leads to prompt window bloat. `MemoryManager` enforces a configurable budget (default: the first 200 lines or 25,000 characters, following Claude Code's pattern) for initial prompt injection.
3. **Transparent Markdown Storage**: Stored as standard human-readable Markdown (`MEMORY.md`) within the project directory. Developers can inspect, edit, or commit it directly.
4. **Structured Note Appending**: Supports programmatic note updates under category headings (`## Conventions`, `## Architecture`, `## Preferences`, `## Environment`, or any host-defined category).
5. **Storage, Not Judgment**: The engine stores and budgets memory; it does not decide what is worth remembering. The host writes notes (e.g. from a "remember" tool or a user command). LLM-based extraction or consolidation of memories is out of scope.
6. **Crash-Safe Writes**: Every write goes to a temp file that is renamed over `MEMORY.md`, so a crash never truncates a file the developer curates. Like sessions, there is a single writer; concurrent `appendNote` calls from two processes can lose a note.
7. **No Runtime Dependencies**: Uses Node.js built-ins (`node:fs`, `node:path`).

---

## 2. Storage Layout

The `MEMORY.md` file sits in the project directory, next to the sessions directory (same layout as [architecture/session.md §2.1](session.md)):
```
<storageRoot>/
└── <projectId>/
    ├── MEMORY.md                 # Project-level persistent memory
    └── sessions/                 # Session JSONL files
```

The path is built with `projectDir` from `src/session/paths.ts`, which also validates `projectId`. `fileName` must be a plain file name (no path separators).

### Default File Structure (`MEMORY.md`)

Headings are the category names exactly, so `appendNote` can find them:

```markdown
# Project Memory

## Conventions
- Always use pnpm for package management.

## Architecture
- Context compaction uses two tiers: micro-pruning followed by rolling-delta macro summarization.

## Preferences
- Prefer concise, technical explanations without filler phrases.

## Environment
- Unit tests run via `npm test -- <pattern>`.
```

---

## 3. Core Types (`src/memory/types.ts`)

```typescript
export interface MemoryConfig {
  /** Root directory for agent storage. */
  storageRoot: string;
  /** Project identifier: a single path segment (see `projectIdFromCwd`). */
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
  /** Maximum characters to return, excluding the truncation footer. */
  maxChars?: number;
}

/** Used verbatim as the `## <category>` heading. */
export type MemoryCategory =
  | "Conventions"
  | "Architecture"
  | "Preferences"
  | "Environment"
  | (string & {});
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
   * Reads memory content formatted for injection into the agent's system prompt,
   * truncated to the line/character budget with a footer (§6).
   *
   * Returns null if the memory file does not exist or is blank.
   */
  readMemory(options?: ReadMemoryOptions): string | null;

  /**
   * Reads the entire, unbudgeted memory file. Returns null if it does not exist.
   */
  readFullMemory(): string | null;

  /**
   * Completely overwrites the memory file with new Markdown content (atomic write).
   * Creates parent directories if they do not exist.
   */
  writeMemory(content: string): void;

  /**
   * Appends a bulleted note under the `## <category>` heading (§5).
   * If the category heading does not exist, it is created.
   */
  appendNote(category: MemoryCategory, note: string): void;

  /**
   * Deletes the project's MEMORY.md file. No-op if it does not exist.
   */
  clear(): void;

  /**
   * Returns true if a memory file exists on disk.
   */
  exists(): boolean;
}
```

---

## 5. Note Appending Algorithm

`appendNote(category, note)`:
1. Normalize the note: trim it and replace internal line breaks with spaces (a note is one bullet line). An empty note is ignored. The category is trimmed; an empty or multi-line category throws.
2. If the file does not exist or is blank, create it as `# Project Memory\n\n## <category>\n- <note>\n`.
3. Otherwise find the first line equal to `## <category>` (trailing whitespace ignored, case-sensitive). The section runs until the next line starting with `# ` or `## `, or the end of the file; `###` subheadings belong to the section.
   - If the section already contains the bullet `- <note>`, do nothing.
   - Otherwise insert `- <note>` after the section's last non-blank line.
4. If the heading is missing, append `## <category>\n- <note>\n` at the end of the file, separated from the previous content by one blank line.
5. Write atomically (temp file + rename).

Headings inside code fences are not special-cased.

---

## 6. Budgeting & Truncation Algorithm

When injecting into the agent's system prompt via `readMemory()`:
1. If the file does not exist or is blank, return `null`.
2. Split the text into lines (a trailing newline does not count as an extra line).
3. Keep at most `maxLines` lines (default 200). Then drop whole lines from the end until the kept text is at most `maxChars` characters (default 25,000). If even the first line is longer than `maxChars`, cut it at `maxChars`.
4. If nothing was dropped, return the raw text unmodified.
5. Otherwise append a footer naming how much was left out and where to find it, so the agent can read the rest with its own tools:
   ```markdown
   [... 140 more lines in /home/me/.agent/projects/my-app/MEMORY.md not loaded to preserve the context budget ...]
   ```
   The count is the number of lines not loaded in full (a cut first line counts). The footer does not count toward `maxChars`.

This ensures that even if developers or agents write massive memory files, cold starts never exhaust prompt tokens.

The host injects the result into its system prompt. It is not stored in the session, so on the heuristic measurement path the host counts it in `ModelBudget.overheadTokens` ([architecture/compaction.md §4](compaction.md)).

---

## 7. Agent Implementation Guide

Tests use a fresh temporary directory per test.

1. **Types** (`types.ts`).
2. **Read paths**: missing file, blank file, under budget (returned unmodified), line limit, character limit (whole lines dropped), single over-long first line, footer content.
3. **Writes**: `writeMemory` creates directories; atomic write leaves no temp file behind; `clear` on a missing file.
4. **`appendNote`**: new file, existing heading (insertion point before the next heading, `###` subheadings kept inside), missing heading, duplicate note, multi-line note collapsed, empty note ignored.
5. **Validation**: invalid `projectId` (`SessionError`) and `fileName` (`Error`) rejected; invalid categories rejected.

The algorithms are exported as pure functions, `budgetMemory(text, limits)` and `insertNote(text, category, note)`, so most cases are tested without the file system. `DEFAULT_MEMORY_FILE_NAME`, `DEFAULT_MAX_CONTEXT_LINES`, and `DEFAULT_MAX_CONTEXT_CHARS` are exported from `types.ts`.
