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

Anthropic’s official CLI coding agent provides a proven model for local session lifecycle and project memory:
- **Project-Scoped Storage**: Sessions live under `~/.claude/projects/<project-slug>/`, where the project slug is derived from the working directory path.
- **Append-Only JSONL Transcripts**: Each session is an append-only JSONL file named `<session-uuid>.jsonl`. Turns, tool outputs, and queue operations are recorded as individual JSON records with UUIDs.
- **File-Based Forking (`--fork-session`, `/fork`)**: When branching from an existing conversation, Claude Code generates a **new session UUID and file**, copying preceding dialogue into the new file. This guarantees that original transcripts remain completely untouched and immutable.
- **Cross-Session Memory (`MEMORY.md`)**:
  - Dynamically recorded project conventions, user preferences, and architectural notes are persisted in `~/.claude/projects/<slug>/memory/MEMORY.md`.
  - **Context Budget Cap**: Only the first 200 lines (or ~25KB) are loaded into initial session context to prevent bloating the prompt window.
  - Background "dream" passes periodically summarize and prune stale references.
- **Session Discovery**: Fast interactive session picker (`claude --resume` / `claude -r`) showing timestamps, git branches, and session titles. Custom naming is supported via `/rename`.

### B. OpenAI Codex CLI (`codex-rs`)

OpenAI’s open-source Rust-based Codex CLI features an enterprise-grade multi-tier architecture:
- **Date-Partitioned Rollout Files**: Sessions are stored under `~/.codex/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<THREAD_ID>.jsonl`.
- **Hybrid SQLite Catalog (`state_5.sqlite`)**: While raw conversation logs are append-only JSONL, an indexed SQLite database stores thread metadata (titles, created/updated timestamps, token usage, workspace paths). This allows instantaneous thread listing without reading hundreds of JSONL files on startup.
- **Host-Driven Retention (`RetainedContext`)**:
  - Preserves verified user answers and explicit host facts across compactions and session reconnects.
  - Retention is deterministic and host-enforced, not left to LLM discretion.
- **Hierarchical Memory with Progressive Disclosure**:
  - Instead of loading large memory files directly into context, Codex uses a multi-tier memory layout:
    1. `memory_summary.md`: A high-density routing index injected into system prompts.
    2. `MEMORY.md`: Detailed preferences and guidelines, grepped on demand by the agent.
    3. `skills/`: Procedural knowledge and tool instructions.
  - Background 2-phase distillation (rollout extraction followed by global consolidation).

### C. Pi (`pi-mono`)

Pi provides a lightweight, pure-TypeScript approach focused on tree persistence:
- **Append-Only Tree Structure**: Each JSONL line contains an `id` and `parentId`. Navigating between branches (`/tree`) moves an in-memory `leafId` pointer within the same file.
- **Delayed Disk Flush**: New sessions stay in memory until the first assistant message completes. If a user quits immediately or sends an empty prompt, no ghost files are written to disk.
- **Schema Migration Pipeline**: Pi includes built-in migration routines (`migrateV1ToV2`, `migrateV2ToV3`) that dynamically upgrade older session files upon load.
- **Limitation**: In-place branching creates complex multi-timeline DAGs inside a single file, complicating external tooling, inspection, and simple linear replay.

---

## 3. Adopted Session & Memory Strategy for `memory_engine`

Synthesizing the strengths of Claude Code, Codex, and Pi, `memory_engine` adopts the following principles:

### 1. Claude-Style File-Based Forking (Single Timeline per File)
Instead of storing multi-branch trees in a single JSONL file:
- Each session file (`.jsonl`) contains a **single, linear conversation timeline**.
- Forking/branching creates a **new session file** with its own unique ID.
- The new session header records `parentSessionId` and `forkedFromEntryId`.
- History up to the fork point is copied into the new file, providing self-contained, crash-resilient files that can be inspected, moved, or deleted with zero cross-file pointer dependency.

### 2. Append-Only JSONL with Delayed Flush
- Sessions are stored in append-only JSONL format.
- To prevent cluttering disk with aborted or empty sessions, `SessionManager` holds new sessions in memory. Disk files are created only when the first assistant response completes.
- Subsequent entries are appended synchronously or safely flushed.

### 3. Progressive Schema Versioning & Migration Framework
- Every session begins with a `SessionHeader` containing `version: 1`.
- `memory_engine` provides a pluggable `Migration` framework:
  ```typescript
  type MigrationFn = (entries: unknown[]) => unknown[];
  ```
- If future versions introduce structural metadata or layout changes, registered migration steps automatically bring older session files up to the current version upon read.

### 4. Decoupled Host-Native Entries
- Conforming to the rule established in `CompactionEngine`, `SessionManager` stores host messages as-is without casting, normalizing, or mutating them.
- `SessionManager<TMsg>` is generic over the host's message type `TMsg`.

### 5. Separate, Dedicated `MemoryManager` (`MEMORY.md`)
Cross-session memory is decoupled from session transcripts:
- Transcripts record *what happened* in a specific conversation.
- `MemoryManager` records *what was learned* across conversations.
- Stored as a human-readable `MEMORY.md` file scoped per project.
- Implements Claude-style bounded reading (e.g., top 200 lines / token limit) for safe injection into system prompts, paired with structured note appending.

### 6. Full Session Discovery Suite
Provides complete standalone discovery utilities without requiring active agent sessions:
- **`listSessions()`**: Returns metadata, titles, turn counts, and preview snippets.
- **`searchSessions()`**: Case-insensitive keyword search across past session transcripts.
- **`deleteSession()`**: Safe removal of session files.
- **`findMostRecent()`**: Rapid lookup for `--continue` resumption.
