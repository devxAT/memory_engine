# Memory Engine Agent Guide

## Project Overview

`memory_engine` is a modular, decoupled memory engine for AI agents (coding, conversational, or research agents). Its purpose is to provide robust session management and context compaction without coupling to any specific agent harness, model provider, or tool framework.

Key capabilities:
- **Two-Tier Context Compaction**: Fast, deterministic micro-pruning of bulky tool outputs combined with macro semantic summarization.
- **Append-Only Tree Session Storage**: Branching, tree-structured JSONL persistence preserving full conversation graphs.
- **Deterministic State Tracking**: Pluggable tracking of touched files, shell states, and execution artifacts stored directly in session metadata.
- **Zero Framework / SDK Coupling**: Pluggable LLM summarizers, token estimators, and tool extractors injected by host agents via dependency injection.

---

## Tech Stack

- **Language**: TypeScript (strict mode, Node.js / ES modules).
- **Dependencies**: Minimal to zero runtime dependencies. No direct SDK dependencies (no `@anthropic-ai/sdk`, `openai`, `@google/genai`, or `@mariozechner/pi-ai`). Host projects inject their own LLM completion and tokenizer functions.
- **Storage**: Append-only JSONL files representing tree-structured session nodes.

---

## Documentation Structure

| File | Purpose | Audience |
| :--- | :--- | :--- |
| `AGENT.md` | Primary entry point for agents. Summarizes goals, guidelines, open topics, and implementation tracking. | Agents & Developers |
| [docs/compaction.md](docs/compaction.md) | Research findings, comparative analysis of agents (Pi, Claude Code, Codex), and foundational compaction principles. | Human readers & Agents |
| [architecture/compaction.md](architecture/compaction.md) | Exhaustive technical specification, interfaces, algorithms, and implementation instructions for the compaction engine. | Implementing Agents |
| `docs/session.md` | *(Planned)* Research and specifications for the session tree and branch management. | Human readers & Agents |
| `architecture/session.md` | *(Planned)* Technical implementation specification for the session manager and context hydration layer. | Implementing Agents |

---

## Open Architectural Discussion Points

The following topics are staged for upcoming discussions:
- **Canonical Message Representation in Session JSONL**: Standardizing JSON keys and schema across different host agent models (`role`, `content`, `toolCalls`, `toolResults`, custom metadata) during the session manager architectural review.
- **Session Tree Branching Mechanics**: Traversals, fork points, and hydration paths from leaves to roots.

---

## Implementation Roadmap & Status

Use this checklist to track implementation progress across the project.

### Phase 1: Compaction Engine (Current Phase)
- [ ] **Core Types & Interfaces**: `types.ts` defining generic messages, token options, and compaction entries.
- [ ] **Pluggable Extraction Layer**:
  - [ ] `ExtractorRegistry` and `ExtractorPlugin` interfaces.
  - [ ] Default `FileOpsExtractor` (configurable tool names and path keys).
- [ ] **Stage 1: Micro-Compaction**:
  - [ ] Tool result pruner with eviction stubs.
  - [ ] `ProactiveMicroStrategy` (per-turn / sliding-window tool pruning).
  - [ ] `ReactiveMicroStrategy` (threshold-triggered tool pruning).
- [ ] **Stage 2: Macro-Compaction**:
  - [ ] Cut-point detector with atomic toolCall/toolResult boundary guarantees.
  - [ ] Turn boundary detection & split-turn bifurcation.
  - [ ] Prompt templates (`SUMMARIZATION_PROMPT`, `UPDATE_PROMPT`, `TURN_PREFIX_PROMPT`).
  - [ ] Summarizer orchestrator using injected host LLM completion functions.
- [ ] **Compaction Topologies**:
  - [ ] `RollingDeltaCompactor` (single rolling summary with iterative updates).
  - [ ] `HierarchicalCompactor` (chunk-based summary tree).
- [ ] **Compaction Unit Tests**: Deterministic test suites verifying boundaries, pruners, and topologies.

### Phase 2: Session Storage & Tree Management
- [ ] Append-only JSONL file store with parent-child linkage.
- [ ] Tree traversal, leaf pointers, and branch forking.
- [ ] Context assembler integrating compaction summaries with active message windows.
