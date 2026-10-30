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
| `docs/session.md` | *(Planned)* Research and specifications for the session tree and branch management. | Human readers & Agents |
| `architecture/session.md` | *(Planned)* Technical implementation specification for the session manager and context hydration layer. | Implementing Agents |

---

## Open Architectural Discussion Points

The following topics are staged for upcoming discussions:
- **Session Header & Message Format Versioning** (Phase 2): the header line that records the host message format and version, and how hosts migrate old sessions.
- **Session Tree Branching Mechanics**: Traversals, fork points, and resolving paths from leaves to roots.
- **Reference Accessors**: whether to ship optional `MessageAccessor` implementations for common host formats, and which ones first.

Resolved:
- ~~Canonical Message Representation~~: the engine does not define a message schema. Host messages are stored as-is and read through a `MessageAccessor` (see [docs/compaction-changes.md](docs/compaction-changes.md)).
- ~~Toolchain Confirmation~~: confirmed as proposed, with Biome chosen for lint/format (see Toolchain & Conventions).

---

## Implementation Roadmap & Status

Use this checklist to track implementation progress across the project.

### Phase 1: Compaction Engine (Current Phase)
- [x] **Core Types & Interfaces**: `types.ts` defining `MessageAccessor`, session entries (message, compaction, prune), settings, `ModelBudget`, and errors.
- [x] **Test Fixture Accessors**: in-repo test message type covering separate tool-result messages, results inside user messages with injected text, and server-side tool calls.
- [x] **Token Measurement**: `tokens.ts` with heuristic estimator and usage-aware context measurement.
- [x] **Tool Pairing & Cut Points**: `groups.ts` pairing calls with results by ID.
- [x] **Pluggable Extraction Layer**:
  - [x] `ExtractorRegistry` and `ExtractorPlugin<S>` interfaces.
  - [x] Default `FileOpsExtractor` (configurable tool names and path keys, path normalization, failed calls ignored).
- [ ] **Stage 1: Micro-Compaction**:
  - [ ] Tool result pruner with eviction stubs (head/tail lines, character cap, long lines, images).
  - [ ] `ProactiveMicroStrategy` (prunes results as they age out of the recent window).
  - [ ] `ReactiveMicroStrategy` (threshold-triggered pruning with a target ratio).
  - [ ] Pruning decisions emitted as `prune` entries.
- [ ] **Stage 2: Macro-Compaction**:
  - [ ] Cut-point detector with atomic toolCall/toolResult boundary guarantees.
  - [ ] Turn boundary detection & split-turn bifurcation.
  - [ ] Conversation serializer (text transcript for the summarizer).
  - [ ] Prompt templates (`SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, `TURN_PREFIX_SUMMARIZATION_PROMPT`) and `PROMPT_VERSION`.
  - [ ] Summarizer using the injected host LLM function (chunking, validation, retry, abort).
- [ ] **Compaction Topology**: `RollingDeltaCompactor` (single rolling summary with iterative updates).
- [ ] **Context Builder**: `context.ts` assembling summary + kept window + prune replacements.
- [ ] **Engine Facade**: `engine.ts` with threshold trigger, micro → macro order, and overflow retry.
- [ ] **Compaction Unit Tests**: Deterministic test suites verifying boundaries, pruners, extractors, and the topology.

### Phase 1b: Evaluation & Hierarchical Topology (Deferred)
- [ ] Evaluation harness: replay recorded sessions; measure tokens saved, summarizer cost, cache hit rate, continuation quality.
- [ ] `HierarchicalCompactor` (chunk-based summary tree), once the preconditions in [architecture/compaction.md §8.3](architecture/compaction.md) are met.

### Phase 2: Session Storage & Tree Management
- [ ] Append-only JSONL file store with parent-child linkage and a session header (message format + version).
- [ ] Tree traversal, leaf pointers, and branch forking.
- [ ] Path resolution (leaf → root) feeding the compaction context builder.
