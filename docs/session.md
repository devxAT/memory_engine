# Session Management & Cross-Session Memory: Analysis, Findings, and Strategy

This document outlines research findings, comparative analyses of existing production coding agents (Claude Code, OpenAI Codex CLI, and Pi), and the foundational architectural decisions governing session persistence, branching, and cross-session memory in `memory_engine`.

The technical specifications live in:
- Session Manager: [architecture/session.md](../architecture/session.md)
- Cross-Session Memory: [architecture/memory.md](../architecture/memory.md)

---

## 1. The Need for Session & Memory Infrastructure

Autonomous coding agents execute complex, multi-step reasoning and coding tasks. Real-world usage requires:
1. **Durability & Crash Recovery**: A process termination, unexpected API error, or system reboot must not discard past conversational context, file modifications, or debugging history.
2. **Session Lineage & Branching**: Developers frequently explore speculative implementation paths, revert regressions, or fork conversations without corrupting working branches.
3. **Session Discovery & Resumption**: Developers need to find previous conversations by task name, search past debugging sessions, or instantly continue where they left off (`--continue`).
4. **Cross-Session Knowledge Retention**: Repetitive instructions (e.g. "always use pnpm", "run tests with vitest", "the auth service is located at path X") must persist across distinct sessions without forcing the developer to re-state them on every run.
5. **Decoupled Architecture**: Like compaction, session management and memory storage must not tie into any specific LLM provider, prompt framework, or terminal UI.

---

## 2. Findings from Existing Agent Harnesses

### A. Claude Code (`claude`)

Anthropic’s official CLI coding agent provides a proven model for local session lifecycle and project memory. The CLI is closed source, so these findings come from the official docs and the open-source Agent SDK, which reads and writes the same transcript files. The docs call the format internal and subject to change.
- **Project-Scoped Storage**: Sessions live under `~/.claude/projects/<project>/`, where `<project>` is the working directory path with every non-alphanumeric character replaced by `-` (long names are cut and given a hash suffix).
- **Append-Only JSONL Transcripts**: Each session is a JSONL file named `<session-id>.jsonl`, append-only in practice. Subagent transcripts are separate files.
- **Parent-Linked Records**: Conversation records carry `uuid` and `parentUuid`. Readers rebuild the conversation by walking back from the latest leaf, so one file can hold several branches (for example after a rewind, or from parallel tool calls).
- **File-Based Forking**: `--fork-session` (with `--resume` or `--continue`) and the in-session `/branch` command copy the conversation into a new session ID and file and switch to it, leaving the original untouched. `/fork` copies it into a new background session while you keep working in the original. The Agent SDK's fork gives every copied record a new ID.
- **Renames**: `/rename` (also `-n` and the picker) appends a `custom-title` record; the last one in the file wins. Titles are also generated automatically.
- **Session Discovery**: The `claude --resume` / `claude -r` picker shows each session's title, time since last activity, git branch, and file size.
- **Two Memory Mechanisms**:
  - `CLAUDE.md`: instructions written by the developer, loaded in full.
  - Auto memory: notes written by Claude under `~/.claude/projects/<project>/memory/`, keyed to the git repository so worktrees share it. `MEMORY.md` is an index with one line per memory, each pointing to a topic file. Only its first 200 lines or 25KB, whichever comes first, are loaded at startup; topic files are read on demand.
  - A background consolidation pass ("dream") that prunes stale entries and keeps the index within its limits appears in prompts extracted from the CLI, but not in the official docs. When it runs is unconfirmed.

### B. OpenAI Codex CLI (`codex-rs`)

OpenAI’s open-source Rust-based Codex CLI features a multi-tier architecture:
- **Date-Partitioned Rollout Files**: Sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-<local timestamp>-<thread id>.jsonl`. Archived sessions move to `archived_sessions/`.
- **Hybrid SQLite Catalog (`state_5.sqlite`)**: While raw conversation logs are append-only JSONL, a SQLite database stores thread metadata (title, name, created/updated timestamps, tokens used, cwd, git branch, rollout path). Listing reads the database, falls back to the filesystem, and repairs the database from it.
- **Host-Owned Retained Context (`RetainedContext`)**:
  - A bounded set of facts kept outside the compaction contract: host-verified answers to `request_user_input`, selected user and assistant messages, and deliveries, each capped (8 records, 64 KiB).
  - Saved with the compaction checkpoint and restored on resume. Compaction does not expire it; rollback does.
  - Retention is deterministic and host-enforced, not left to LLM discretion.
- **Hierarchical Memory with Progressive Disclosure** (off by default), under `~/.codex/memories/`:
  - Instead of loading large memory files directly into context, Codex uses a multi-tier memory layout:
    1. `memory_summary.md`: always loaded into the system prompt.
    2. `MEMORY.md`: detailed notes the agent greps for keywords.
    3. `skills/<name>/SKILL.md`: procedural knowledge. Per-rollout summaries live in `rollout_summaries/`.
  - Built by background two-phase distillation: per-rollout extraction into SQLite, then a consolidation sub-agent running under a global lock.

### C. Pi (`pi-mono`)

Pi provides a lightweight, pure-TypeScript approach focused on tree persistence:
- **Append-Only Tree Structure**: Each JSONL entry contains an `id` and `parentId`. Navigating between branches (`/tree`) moves an in-memory leaf pointer within the same file, and new entries attach to that leaf. `/fork` and `/clone` create new session files.
- **Delayed Disk Flush**: A new session stays in memory until it contains its first user or assistant message. The file is then created exclusively (`wx`) with every buffered entry, and later entries are appended. A session the user quits before typing anything never reaches disk.
- **Schema Migration Pipeline**: The current version is 3. `migrateV1ToV2` (adds IDs, parent links, and `firstKeptEntryId`) and `migrateV2ToV3` (renames the `hookMessage` role to `custom`) run on load; if anything changed, the file is rewritten.
- **Renames and Listing**: A rename appends a `session_info` entry; the newest wins. Listing streams every line of every session file.

### D. Observation: Branches Inside One File
Claude Code and Pi both let one file hold several timelines. Every reader then has to resolve the active branch from parent links, which complicates external tooling, inspection, and simple linear replay. Both also offer forking into a new file.

---

## 3. Adopted Session & Memory Strategy for `memory_engine`

Synthesizing the strengths of Claude Code, Codex, and Pi, `memory_engine` adopts the following principles:

### 1. File-Based Forking (Single Timeline per File)
Claude Code and Pi fork into new files but also allow branches inside one file (§2D). `memory_engine` keeps only the file fork. Instead of storing multi-branch trees in a single JSONL file:
- Each session file (`.jsonl`) contains a **single, linear conversation timeline**. File order is the conversation path, so the compaction engine reads it directly with no tree traversal.
- Forking/branching creates a **new session file** with its own unique ID.
- The new session header records `parentSessionId` and `forkedFromEntryId`.
- History up to the fork point is copied verbatim (entry IDs included) into the new file, providing self-contained, crash-resilient files that can be inspected, moved, or deleted with zero cross-file pointer dependency. Unlike the Claude Agent SDK's fork, IDs are not reassigned, so compaction references such as `firstKeptEntryId` stay valid without being rewritten.
- Rewinding to an earlier message to try again is also a fork.
- **Trade-off**: every fork duplicates its history on disk, and there is no in-place `/tree`-style navigation between branches. In exchange, external tools can read any session as a plain linear log.

### 2. Append-Only JSONL with Delayed Flush
- Sessions are stored in append-only JSONL format. Existing lines are never edited; renames are appended as `title` entries.
- To prevent cluttering disk with aborted or empty sessions, `SessionManager` holds new sessions in memory. The file is created when the first model message is appended (the manager learns a message's origin from the host's `MessageAccessor`) or when the host calls `flush()`.
- Subsequent entries are appended synchronously, one write per entry.
- A crash mid-write leaves at most a torn last line, which readers drop.
- **Trade-off**: a crash before the first flush loses the first prompt. Pi flushes earlier, at the first user or assistant message, which keeps the prompt but writes a file for a session abandoned before the first reply.

### 3. Progressive Schema Versioning & Migration Framework
Two things can change independently, and each has its own version:
- **Engine schema**: every session begins with a `SessionHeader` containing `version: 1`. The engine ships its own sequential `Migration` steps (`fromVersion` → `fromVersion + 1`) that bring older files up to the current version on read. Files from a newer engine are refused.
- **Host message format**: the header records the host's `messageFormat` (e.g. `"my-agent/messages@3"`). When the host's type changes, it supplies an `upgradeMessage` function for old messages.
- A migrated file is rewritten (temp file + rename) before anything is appended, so new entries are never migrated twice.

### 4. Decoupled Host-Native Entries
- Conforming to the rule established in `CompactionEngine`, `SessionManager` stores host messages as-is without casting, normalizing, or mutating them.
- `SessionManager<TMsg>` is generic over the host's message type `TMsg`.

### 5. Separate, Dedicated `MemoryManager` (`MEMORY.md`)
Cross-session memory is decoupled from session transcripts:
- Transcripts record *what happened* in a specific conversation.
- `MemoryManager` records *what was learned* across conversations.
- Stored as a human-readable `MEMORY.md` file scoped per project.
- Implements Claude-style bounded reading (first 200 lines / 25,000 characters by default) for safe injection into system prompts, paired with structured note appending under category headings.
- Simpler than both references: Claude Code's auto memory and Codex load a short index and read detail files on demand, while v1 keeps the notes themselves in one file. Moving to an index plus topic files is an open point.
- The engine stores and budgets memory; the host decides what to remember. LLM-based extraction and consolidation (as in Codex) are out of scope for now.

### 6. Full Session Discovery Suite
Provides complete standalone discovery utilities without requiring active agent sessions:
- **`listSessions()`**: Returns metadata, titles, message counts, and preview snippets.
- **`searchSessions()`**: Case-insensitive keyword search across past session transcripts.
- **`deleteSession()`**: Safe removal of session files.
- **`findMostRecent()`**: Rapid lookup for `--continue` resumption.
- **`renameSession()`**: Appends a new title to a stored session.

Listing reads each session file in full, since titles and counts can be anywhere in the file. Previews and content search need the host's `MessageAccessor`, because only the host can tell which message is the human's and extract its text. A Codex-style catalog is deferred until listing is measurably slow.

### 7. Known Limits
- **Single writer**: one process writes a session file or `MEMORY.md` at a time. There is no locking.
- **Whole-file loading**: opening a session parses every line, including history that a compaction has already summarized.
