# Memory Engine Agent Guide

## Project Overview

`memory_engine` is a modular, decoupled memory engine for AI agents (coding, conversational, or research agents). Its purpose is to provide robust session management and context compaction without coupling to any specific agent harness, model provider, or tool framework.

Key capabilities:
- **Two-Tier Context Compaction**: Fast, deterministic micro-pruning of bulky tool outputs combined with macro semantic summarization.
- **Append-Only Tree Session Storage**: Branching, tree-structured JSONL persistence preserving full conversation graphs.
- **Host-Native Messages**: Each host's own message type is stored unchanged. The engine reads it through an injected `MessageAccessor`, so nothing is lost in conversion.
- **Deterministic State Tracking**: Pluggable tracking of touched files, shell states, and execution artifacts stored directly in session metadata.
- **Zero Framework / SDK Coupling**: The host injects its message accessor, LLM summarizer, and optional token usage/estimation via dependency injection.

---

## Tech Stack

- **Language**: TypeScript (strict mode, Node.js / ES modules).
- **Dependencies**: Minimal to zero runtime dependencies. No direct SDK dependencies (no `@anthropic-ai/sdk`, `openai`, `@google/genai`, or `@mariozechner/pi-ai`). Host projects inject their own LLM completion and tokenizer functions.
- **Storage**: Append-only JSONL files representing tree-structured session nodes. Messages are stored in the host's own format.

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
| [architecture/session.md](architecture/session.md) | Exhaustive technical specification for the session manager, delayed flush, forking, discovery, and migrations. | Implementing Agents |
| [architecture/memory.md](architecture/memory.md) | Exhaustive technical specification for cross-session persistent memory (`MemoryManager` / `MEMORY.md`). | Implementing Agents |

---

## Open Architectural Discussion Points

The following topics are staged for upcoming discussions:
- **Reference Accessors**: whether to ship optional `MessageAccessor` implementations for common host formats (OpenAI, Anthropic, Pi), and which ones first.
- **Session Compression**: evaluate optional transparent Zstandard (`.zst`) compression for archived/historical session transcripts.

Resolved:
- ~~Canonical Message Representation~~: the engine does not define a message schema. Host messages are stored as-is and read through a `MessageAccessor` (see [docs/compaction-changes.md](docs/compaction-changes.md)).
- ~~Toolchain Confirmation~~: confirmed as proposed, with Biome chosen for lint/format (see Toolchain & Conventions).
- ~~Session Branching Strategy~~: adopted Claude-style file-based forking (`parentSessionId` linkage with new file) rather than complex in-file DAG trees (see [architecture/session.md](architecture/session.md)).
- ~~Session Migration Framework~~: adopted sequential versioned migration pipeline starting at `version: 1` (see [architecture/session.md](architecture/session.md)).
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

### Phase 2: Session Manager & Cross-Session Memory (Current Phase)
- [ ] **Session Types & Headers**: `src/session/types.ts` defining `SessionHeader` (version 1, title, metadata, parentSessionId), `SessionConfig`, and `SessionSummary`.
- [ ] **Migration Pipeline**: `src/session/migrations.ts` with `MigrationRegistry` and runner.
- [ ] **JSONL Storage & Delayed Flush**: `src/session/store.ts` and `src/session/manager.ts` implementing in-memory buffer, flush on first assistant completion, and append-only disk writes.
- [ ] **Claude-Style Forking**: `sessionManager.fork()` creating isolated new files linked to parent sessions.
- [ ] **Session Discovery API**: `src/session/discovery.ts` implementing `listSessions`, `searchSessions`, `deleteSession`, `findMostRecent`, and `renameSession`.
- [ ] **Cross-Session Memory (`MemoryManager`)**: `src/memory/manager.ts` implementing `readMemory` with 200-line budget, `writeMemory`, `appendNote`, and `clear`.
- [ ] **Session & Memory Unit Tests**: Full test suite mirroring compaction tests.

### Phase 3: Evaluation & Hierarchical Topology (Deferred)
- [ ] Evaluation harness: replay recorded sessions; measure tokens saved, summarizer cost, cache hit rate, continuation quality.
- [ ] `HierarchicalCompactor` (chunk-based summary tree), once the preconditions in [architecture/compaction.md §8.3](architecture/compaction.md) are met.
