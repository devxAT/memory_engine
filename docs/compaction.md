# Context Compaction: Analysis, Findings, and Strategy

This document outlines the findings, comparative research across production agent harnesses, and foundational decisions governing context compaction in `memory_engine`.

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
Claude Code distinguishes between different layers of context pressure:
- **Micro-Compaction**: Tool outputs (such as large directory listings, large file reads, or massive test failures) are pruned or truncated early once their immediate utility has passed. This recovers substantial context with zero LLM inference cost.
- **Macro-Compaction**: When token consumption crosses high-water thresholds (~80-90% of model context), the harness performs semantic summarization of conversation history.
- **Prompt Cache Awareness**: Compaction is scheduled to minimize invalidation of prefix prompt caches.

### C. OpenAI Codex & SWE-Bench Harnesses
- **Sliding Window FIFO**: Naive dropping of oldest messages, retaining the last $K$ turns. High risk of forgetting core user goals and architectural decisions.
- **External Scratchpad Pattern**: Maintains an explicit state tracking document (goals, plan, file state) outside message history and resets context back to system prompt + scratchpad.
- **Hierarchical / Chunked Compaction**: Messages are grouped into discrete blocks (e.g. 10 turns each). Summaries are built per block, forming a tree of summaries as sessions grow.

---

## 3. Adopted Compaction Strategy

Based on these findings, `memory_engine` adopts a synthesized model:

### 1. Two-Tier Lifecycle (Micro vs Macro)
Compaction operates in two distinct phases:
- **Stage 1 (Micro-Compaction)**: Fast, deterministic reduction of bulky tool results without calling an LLM. Large outputs are truncated with clear eviction stubs (e.g. `[Output pruned: 1,500 lines of test output]`), and stale file-read buffers are cleaned up.
- **Stage 2 (Macro-Compaction)**: If micro-compaction is insufficient to stay under token limits, the engine executes semantic summarization of older turns.

### 2. Strict Boundary Safety
- **Tool Call Atomicity**: A tool call and its result must never be severed.
- **Split-Turn Bifurcation**: If the cut point lands inside an in-flight tool loop, the active turn is split into a summarized prefix and a raw retained suffix, preserving the user's initial prompt and recent tool state.

### 3. Structured Markdown Schema & Delta Updates
Macro-compaction enforces a strict, actionable schema:
- `## Goal`: Active user objectives and requirements.
- `## Constraints & Preferences`: Project or user-imposed constraints.
- `## Progress`: Divided into `### Done`, `### In Progress`, and `### Blocked`.
- `## Key Decisions`: Decisions made and their rationale.
- `## Next Steps`: Ordered pending actions.
- `## Critical Context`: Exact symbols, error codes, and configuration values.

Subsequent compactions pass the existing summary as `<previous-summary>`, prompting the LLM to update items rather than starting anew.

### 4. Deterministic State Tracking via Pluggable Extractors
File operations, command outcomes, and tool metrics are extracted programmatically by code, not generated by LLM reasoning.
To ensure the engine works across any agent framework, extraction is **pluggable**: the host agent registers rules indicating which tool names and parameter keys represent file reads, edits, or shell commands.

### 5. Self-Contained JSONL Storage
Both deterministic metadata (`details`) and semantic summaries (`summary`) are persisted directly inside `CompactionEntry` nodes within the append-only JSONL session file. No untracked scratchpad files are written to the user's project workspace, ensuring clean git status and zero side effects when switching branches.

### 6. Decoupled Host Integration
`memory_engine` contains no hardcoded LLM SDK dependencies. The host agent injects:
- An LLM summarization function: `(messages, options) => Promise<string>`.
- An optional token estimation callback, with a character-heuristic fallback.

---

## 4. Parallel Experiments for Benchmarking

To determine optimal performance and context retention, the engine implements two parallel strategies for both Micro and Macro phases:

### A. Micro-Compaction: Proactive vs Reactive
- **Proactive Strategy**: Sanitizes and truncates tool results on every turn or within a small sliding window. Keeps memory lean at all times.
- **Reactive Strategy**: Leaves raw tool outputs intact until total context approaches the reserve threshold, pruning only when necessary. Maximizes raw context availability until pressure requires cleanup.

### B. Macro-Compaction Topology: Rolling Delta vs Hierarchical Tree
- **Rolling Delta (Pi Model)**: A single running summary updated iteratively across compaction events. Simple, fast, and token-efficient.
- **Hierarchical Tree**: Groups turns into fixed or logical chunks with dedicated summary nodes. Higher-level nodes summarize lower-level chunks, allowing localized retrieval and auditing of historic phases.
