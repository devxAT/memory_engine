# Context Compaction: Analysis, Findings, and Strategy

This document outlines the findings, comparative research across production agent harnesses, and foundational decisions governing context compaction in `memory_engine`.

The full technical specification lives in [architecture/compaction.md](../architecture/compaction.md). Changes made after the first review are recorded in [compaction-changes.md](compaction-changes.md).

---

## 1. The Context Constraint

Autonomous agents operate through iterative perception-action loops: generating thoughts, invoking tools, and evaluating execution results. In long-running tasks, this structure creates monotonic context growth:
- Monolithic command outputs (e.g. `npm test`, compiler diagnostics, `git diff`) quickly consume tens of thousands of tokens.
- Repeated file reads inflate context with redundant data.
- LLM context windows, while growing, suffer from degraded reasoning performance ("needle in a haystack" deterioration), slower generation speeds, and linearly increasing inference costs.

Without compaction, agents either hit hard context limits or suffer catastrophic degradation.

---

## 2. Findings from Existing Agent Harnesses

### A. Pi (`pi-mono`)
Pi provides one of the cleanest production reference designs for compaction:
- **Append-Only Tree**: Compactions are recorded as immutable `CompactionEntry` records in a JSONL file, pointing to the earliest kept entry ID (`firstKeptEntryId`). History is never deleted on disk.
- **Atomic Tool Boundaries**: A tool call and its corresponding `toolResult` are treated as an atomic unit. A cut point is never placed between them.
- **Split-Turn Handling**: When the token budget requires cutting in the middle of an active user turn with chained tool actions, Pi bisects the turn:
  1. Older completed turns are summarized into a general history summary.
  2. Early actions of the active turn are summarized into a specialized *Turn-Prefix* summary.
  3. The latest actions (turn suffix) are preserved raw.
- **Deterministic State Tracking**: File operations (`read`, `write`, `edit`) are extracted directly from tool call parameters in code and appended deterministically as `<read-files>` and `<modified-files>` blocks, avoiding LLM hallucination.
- **Delta Updating**: Subsequent compactions feed `<previous-summary>` and `<conversation>` into an update prompt, updating progress and decisions rather than re-summarizing from scratch.

### B. Claude Code
*Based on public documentation and observed behavior; the internal implementation is not published.*

Claude Code distinguishes between different layers of context pressure:
- **Micro-Compaction**: Tool outputs (such as large directory listings, large file reads, or massive test failures) are pruned or truncated early once their immediate utility has passed. This recovers substantial context with zero LLM inference cost.
- **Macro-Compaction**: When token consumption nears the context limit (a high-water threshold), the harness performs semantic summarization of conversation history. A manual compact command is also available.
- **Prompt Cache Awareness**: Compaction is scheduled to minimize invalidation of prefix prompt caches.

### C. OpenAI Codex CLI
- **Auto-Compaction via Summarization**: When token usage approaches a configurable limit, Codex CLI summarizes the conversation with an LLM and continues from the summary. A manual compact command is also available.

### D. Other Patterns (Research & SWE-Bench Harnesses)
- **Sliding Window FIFO**: Naive dropping of oldest messages, retaining the last $K$ turns. High risk of forgetting core user goals and architectural decisions.
- **External Scratchpad Pattern**: Maintains an explicit state tracking document (goals, plan, file state) outside message history and resets context back to system prompt + scratchpad.
- **Hierarchical / Chunked Compaction**: Messages are grouped into discrete blocks (e.g. 10 turns each). Summaries are built per block, forming a tree of summaries as sessions grow.

---

## 3. Adopted Compaction Strategy

Based on these findings, `memory_engine` adopts a synthesized model:

### 1. Two-Tier Lifecycle (Micro vs Macro)
Compaction operates in two distinct phases:
- **Stage 1 (Micro-Compaction)**: Fast, deterministic reduction of bulky tool results without calling an LLM. Large outputs are truncated with clear eviction stubs (e.g. `[... truncated 1,480 lines ...]`), and file reads made stale by a later read or edit of the same file are evicted.
  - Recency is measured in tool results, not user turns. A coding agent often handles one user prompt with hundreds of tool calls, so "older than the current user turn" would never prune anything.
  - Pruning decisions are saved as `prune` entries in the session. The context then stays identical from request to request, which keeps the prompt cache stable, instead of being recomputed (and possibly changing) on every request.
- **Stage 2 (Macro-Compaction)**: If micro-compaction is insufficient to stay under token limits, the engine executes semantic summarization of older turns.

### 2. Strict Boundary Safety
- **Tool Call Atomicity**: A tool call and its result must never be severed. Pairing is done by matching call IDs to result IDs, so it works wherever the result lives: in its own message, inside a user message, or inside the same assistant message (server-side tools).
- **Turn Boundaries by Origin**: A turn starts only at a message written by the human. Tool output and text injected by the harness (reminders, steering) never start a turn, even when the provider gives them the `user` role.
- **Split-Turn Bifurcation**: If the cut point lands inside an in-flight tool loop, the active turn is split into a summarized prefix and a raw retained suffix, preserving the user's initial prompt and recent tool state.

### 3. Structured Markdown Schema & Delta Updates
Macro-compaction enforces a strict, actionable schema:
- `## Goal`: Active user objectives and requirements.
- `## Constraints & Preferences`: Project or user-imposed constraints.
- `## Progress`: Divided into `### Done`, `### In Progress`, and `### Blocked`.
- `## Key Decisions`: Decisions made and their rationale.
- `## Next Steps`: Ordered pending actions.
- `## Critical Context`: Exact symbols, error codes, and configuration values.

Subsequent compactions pass the existing summary as `<previous-summary>`, prompting the LLM to update items rather than starting anew. The update prompt repeats the full schema, because the model never sees the original prompt.

The LLM-written summary and the deterministic file lists are stored separately. File lists are rendered only when the context is built, so they are never fed back through the LLM to be rewritten or invented.

### 4. Deterministic State Tracking via Pluggable Extractors
File operations, command outcomes, and tool metrics are extracted programmatically by code, not generated by LLM reasoning.
To ensure the engine works across any agent framework, extraction is **pluggable**: the host agent registers rules indicating which tool names and parameter keys represent file reads, edits, or shell commands. Each extractor owns its own state and stores it under its own key in the compaction entry. Failed tool calls are ignored, and file paths are normalized.

### 5. Host-Native Message Storage
The engine does not define a message schema. No single schema fits every agent, and multi-provider agents already have their own unified message type that works across all their providers.

The engine therefore stores the host's messages unchanged and reads them through a `MessageAccessor` the host supplies. The accessor answers the only questions compaction needs: did a human write this message, what tool calls and results does it carry, what is its text, how to replace a tool result, and how to build the summary message.

- **Nothing is lost in conversion**: thinking signatures, encrypted reasoning, and provider metadata survive because messages are never converted.
- **Works with structured and text-based tool calling**: agents that write tool calls as text parse them in their accessor.
- **Trade-off**: a session file belongs to one host format. The session header records the format and version so the host can migrate old sessions.
- **Out of scope**: provider-held history (server-side conversation state), because the host does not have the history to compact.

### 6. Self-Contained JSONL Storage
Deterministic metadata (`details`), semantic summaries (`summary`), and pruning decisions are persisted as entries in the append-only JSONL session file. No untracked scratchpad files are written to the user's project workspace, ensuring clean git status and zero side effects when switching branches.

### 7. Decoupled Host Integration
`memory_engine` contains no hardcoded LLM SDK dependencies. The host agent injects:
- A `MessageAccessor` for its message type.
- An LLM summarization function: text prompt in, summary text out. The engine turns the conversation into a text transcript first, so the model summarizes it instead of trying to continue it or call tools.
- Optionally, provider-reported token usage and a token estimator, with a character-heuristic fallback.

### 8. Triggering & Budgets
- Context size is measured from provider-reported token usage when available, plus estimates for messages added since. Otherwise a heuristic estimate is used.
- Compaction triggers when the context exceeds the model's context window minus a reserve. The context window is passed at call time, because the host can switch models mid-session.
- On a provider context-overflow error, the host compacts and retries once.
- Histories larger than the summarizer's input budget are summarized in sequential chunks.
- When nothing can be compacted (e.g. a single huge recent tool result), the engine reports it and micro-pruning is the only remaining lever.
- Summaries are validated (required sections present, smaller than what they replace). A failed compaction leaves the context uncompacted.

---

## 4. Parallel Experiments for Benchmarking

To determine optimal performance and context retention, the engine supports alternative strategies for comparison:

### A. Micro-Compaction: Proactive vs Reactive
- **Proactive Strategy**: Truncates each oversized tool result once it ages out of the recent window. Keeps memory lean at all times and only touches the recent end of the prompt cache.
- **Reactive Strategy**: Leaves raw tool outputs intact until total context approaches the reserve threshold, then prunes the largest results first. Maximizes raw context availability, but pruning old messages can invalidate most of the prompt cache.

### B. Macro-Compaction Topology: Rolling Delta vs Hierarchical Tree
- **Rolling Delta (Pi Model), Phase 1**: A single running summary updated iteratively across compaction events. Simple, fast, and token-efficient.
- **Hierarchical Tree, deferred to Phase 3**: Groups turns into chunks with dedicated summary nodes, with higher-level nodes summarizing lower-level ones. Deferred because it needs a richer data model (summaries covering entry ranges, several active summaries), its main benefit (localized retrieval) needs a retrieval mechanism that does not exist yet, and it cannot be judged without an evaluation harness and a rolling-delta baseline.

### C. Evaluation Metrics
Comparisons are made by replaying recorded sessions and measuring:
- **Tokens saved** per micro and macro step.
- **Summarizer cost**: number of calls and input/output tokens.
- **Prompt-cache hit rate** across requests.
- **Continuation quality**: probe questions about goals, decisions, and file state, answered from the compacted context.
- **Compactions per session.**

Every compaction entry records the prompt version and a summarizer label so results can be reproduced.
