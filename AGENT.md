# Memory Engine Agent Guide

## Project Overview

`memory_engine` is a modular, decoupled memory engine for AI agents (coding, conversational, or research agents). Its purpose is to provide robust session management and context compaction without coupling to any specific agent harness, model provider, or tool framework.

Key capabilities:
- **Two-Tier Context Compaction**: Fast, deterministic micro-pruning of bulky tool outputs combined with macro semantic summarization.
- **Append-Only JSONL Sessions**: One linear timeline per file with a versioned header and delayed flush. Forking writes a new self-contained file linked to its parent.
- **Cross-Session Memory**: A per-project `MEMORY.md` with category notes and a bounded read for prompt injection.
- **Host-Native Messages**: Each host's own message type is stored unchanged. The engine reads it through an injected `MessageAccessor`, so nothing is lost in conversion.
- **Deterministic State Tracking**: Pluggable tracking of touched files, shell states, and execution artifacts stored directly in session metadata.
- **Zero Framework / SDK Coupling**: The host injects its message accessor, LLM summarizer, and optional token usage/estimation via dependency injection.

---

## Tech Stack

- **Language**: TypeScript (strict mode, Node.js / ES modules).
- **Dependencies**: Minimal to zero runtime dependencies. No direct SDK dependencies (no `@anthropic-ai/sdk`, `openai`, `@google/genai`, or `@mariozechner/pi-ai`). Host projects inject their own LLM completion and tokenizer functions.
- **Storage**: Append-only JSONL session files, one linear timeline each, plus a Markdown `MEMORY.md` per project. Messages are stored in the host's own format.

---

## Toolchain & Conventions

- **Runtime**: Node.js ≥ 22 (LTS), ES modules (`"type": "module"`).
- **TypeScript**: strict, `module`/`moduleResolution: "NodeNext"`, target ES2022, `verbatimModuleSyntax` (use `import type` for type-only imports). Relative imports use the `.js` extension.
  - `tsconfig.json`: type-checks `src/`, `test/`, and config files; never emits.
  - `tsconfig.build.json`: compiles `src/` only to `dist/` with declarations.
- **Package manager**: npm.
- **Tests**: Vitest. Tests live in `test/`, mirroring `src/`. Shared fixtures (e.g. test message accessors) live in `test/fixtures/`. Type-level assertions (`expectTypeOf`) are no-ops at runtime; `npm run typecheck` is what verifies them.
- **Lint / format**: Biome (`biome.json`): 2-space indent, double quotes, semicolons, trailing commas, 100-column lines, recommended lint rules, organized imports. Markdown files are excluded.
- **Commands**:
  - `npm run build`: compile with `tsc -p tsconfig.build.json`.
  - `npm run typecheck`: `tsc --noEmit`.
  - `npm test`: `vitest run`.
  - `npm run lint`: `biome check` (format + lint + import order; fails on any issue).
  - `npm run lint:fix`: `biome check --write` (applies safe fixes and formatting).
  - `npm run format`: `biome format --write`.
- **Code conventions**:
  - No runtime dependencies.
  - Named exports only.
  - Prefer pure functions over classes where state is not needed.
  - Never mutate host messages; copy via the accessor.
  - Tests must be deterministic; LLM calls are always faked.

---

## Documentation Structure

| File | Purpose | Audience |
| :--- | :--- | :--- |
| `AGENT.md` | Primary entry point for agents. Summarizes goals, guidelines, open topics, and implementation tracking. | Agents & Developers |
| [docs/compaction.md](docs/compaction.md) | Research findings, comparative analysis of agents (Pi, Claude Code, Codex), and foundational compaction principles. | Human readers & Agents |
| [docs/compaction-changes.md](docs/compaction-changes.md) | What changed in the compaction docs after review, and why. | Human readers & Agents |
| [architecture/compaction.md](architecture/compaction.md) | Exhaustive technical specification, interfaces, algorithms, and implementation instructions for the compaction engine. | Implementing Agents |
| [docs/session.md](docs/session.md) | Research findings, comparative analysis of session management and memory across Claude Code, Codex, and Pi. | Human readers & Agents |
| [docs/session-changes.md](docs/session-changes.md) | What changed in the session and memory docs after review, and why. | Human readers & Agents |
| [architecture/session.md](architecture/session.md) | Exhaustive technical specification for the session manager, delayed flush, forking, discovery, and migrations. | Implementing Agents |
| [architecture/memory.md](architecture/memory.md) | Exhaustive technical specification for cross-session persistent memory (`MemoryManager` / `MEMORY.md`). | Implementing Agents |

---

## Open Architectural Discussion Points

The following topics are staged for upcoming discussions:
- **Reference Accessors**: whether to ship optional `MessageAccessor` implementations for common host formats (OpenAI, Anthropic, Pi), and which ones first.
- **Session Compression**: evaluate optional transparent Zstandard (`.zst`) compression for archived/historical session transcripts.
- **Session Catalog**: an index of session summaries (like Codex's SQLite state database) if full-scan listing gets slow.
- **Concurrent Writers**: sessions and memory assume a single writer; decide whether to add locking.
- **Memory Layout**: whether to move from one categorized `MEMORY.md` to an index plus topic files read on demand.

Resolved:
- ~~Canonical Message Representation~~: the engine does not define a message schema. Host messages are stored as-is and read through a `MessageAccessor` (see [docs/compaction-changes.md](docs/compaction-changes.md)).
- ~~Toolchain Confirmation~~: confirmed as proposed, with Biome chosen for lint/format (see Toolchain & Conventions).
- ~~Session Branching Strategy~~: adopted Claude-style file-based forking (`parentSessionId` linkage with new file) rather than complex in-file DAG trees (see [architecture/session.md](architecture/session.md)).
- ~~Session Migration Framework~~: adopted sequential versioned migration pipeline starting at `version: 1`, plus host-driven message format upgrades (see [architecture/session.md](architecture/session.md)).
- ~~Session Header & Message Format Versioning~~: the header records the engine schema `version` and the host's `messageFormat` (see [docs/session-changes.md](docs/session-changes.md)).
- ~~Cross-Session Memory Architecture~~: decoupled into a standalone `MemoryManager` class managing bounded `MEMORY.md` (see [architecture/memory.md](architecture/memory.md)).

---

## Implementation Roadmap & Status

Use this checklist to track implementation progress across the project.

### Phase 1: Compaction Engine (Complete)
- [x] **Core Types & Interfaces**: `types.ts` defining `MessageAccessor`, session entries (message, compaction, prune), settings, `ModelBudget`, and errors.
- [x] **Test Fixture Accessors**: in-repo test message type covering separate tool-result messages, results inside user messages with injected text, and server-side tool calls.
- [x] **Token Measurement**: `tokens.ts` with heuristic estimator and usage-aware context measurement.
- [x] **Tool Pairing & Cut Points**: `groups.ts` pairing calls with results by ID.
- [x] **Pluggable Extraction Layer**:
  - [x] `ExtractorRegistry` and `ExtractorPlugin<S>` interfaces.
  - [x] Default `FileOpsExtractor` (configurable tool names and path keys, path normalization, failed calls ignored).
- [x] **Stage 1: Micro-Compaction**:
  - [x] Tool result pruner with eviction stubs (head/tail lines, character cap, long lines, images).
  - [x] `ProactiveMicroStrategy` (prunes results as they age out of the recent window).
  - [x] `ReactiveMicroStrategy` (threshold-triggered pruning with a target ratio).
  - [x] Pruning decisions emitted as `prune` entries.
- [x] **Stage 2: Macro-Compaction**:
  - [x] Cut-point detector with atomic toolCall/toolResult boundary guarantees.
  - [x] Turn boundary detection & split-turn bifurcation.
  - [x] Conversation serializer (text transcript for the summarizer).
  - [x] Prompt templates (`SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, `TURN_PREFIX_SUMMARIZATION_PROMPT`) and `PROMPT_VERSION`.
  - [x] Summarizer using the injected host LLM function (chunking, validation, retry, abort).
- [x] **Compaction Topology**: `RollingDeltaCompactor` (single rolling summary with iterative updates).
- [x] **Context Builder**: `context.ts` assembling summary + kept window + prune replacements.
- [x] **Engine Facade**: `engine.ts` with threshold trigger, micro → macro order, and overflow retry.
- [x] **Compaction Unit Tests**: Deterministic test suites verifying boundaries, pruners, extractors, and the topology.

### Phase 2: Session Manager & Cross-Session Memory (Complete)
- [x] **Session Types & Headers**: `src/session/types.ts` defining `SessionHeader` (version, messageFormat, title, metadata, fork lineage), `TitleEntry`, `CustomEntry`, configs, discovery types, and `SessionError`.
- [x] **Storage Layout**: `src/session/paths.ts` with `projectId` validation, `projectIdFromCwd`, and file naming.
- [x] **JSONL Store**: `src/session/store.ts` with parsing (torn last line tolerated), exclusive create, append, and atomic rewrite.
- [x] **Migration Pipeline**: `src/session/migrations.ts` with built-in `MIGRATIONS` and the `migrateSession` runner.
- [x] **Session Manager & Delayed Flush**: `src/session/manager.ts` with `create`/`open`, in-memory buffer, flush on the first model message (via accessor) or `flush()`, append-only writes, title entries, and message format upgrades.
- [x] **Claude-Style Forking**: `fork()` writing a new file with verbatim entry copies and parent lineage.
- [x] **Session Discovery API**: `src/session/discovery.ts` implementing `listSessions`, `searchSessions`, `findMostRecent`, `deleteSession`, and `renameSession`.
- [x] **Cross-Session Memory (`MemoryManager`)**: `src/memory/manager.ts` implementing budgeted `readMemory`, `readFullMemory`, `writeMemory`, `appendNote`, `clear`, and `exists`.
- [x] **Session & Memory Unit Tests**: Full test suite mirroring compaction tests, plus a `CompactionEngine` + `SessionManager` integration test.

### Phase 3: Evaluation & Hierarchical Topology (Deferred)
- [ ] Evaluation harness: replay recorded sessions; measure tokens saved, summarizer cost, cache hit rate, continuation quality.
- [ ] `HierarchicalCompactor` (chunk-based summary tree), once the preconditions in [architecture/compaction.md §8.3](architecture/compaction.md) are met.
