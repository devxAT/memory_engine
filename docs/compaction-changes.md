# Compaction Docs: Changes After First Review

**Date**: 2026-10-31

This file records what changed in the compaction docs after the first design review, and why. The main docs are already updated; this is the summary of the differences.

Files changed:
- [architecture/compaction.md](../architecture/compaction.md) (most changes; section numbers below refer to the new version)
- [docs/compaction.md](compaction.md)
- [AGENT.md](../AGENT.md)

---

## Summary

| # | Change | Type |
| :--- | :--- | :--- |
| 1 | Host messages stored as-is, read through a `MessageAccessor` | Design |
| 2 | Turn starts decided by message origin; atomicity by call/result IDs | Design |
| 3 | Rolling delta starts at the previous compaction's kept window | Bug fix |
| 4 | File lists stored separately from the LLM summary | Bug fix |
| 5 | Prompts reworked (update prompt carries full format, transcript input, versioning) | Bug fix |
| 6 | `CompactionEntry` fields corrected and extended | Bug fix |
| 7 | New "Token Measurement & Triggering" section | Gap |
| 8 | Micro-compaction decisions saved as `prune` entries; recency by tool results | Design |
| 9 | Summarizer: text in/out, validation, retry, chunking, abort | Gap |
| 10 | Extractors: generic per-plugin state, failed calls ignored, paths normalized | Design |
| 11 | Topology decides what to summarize; new engine facade and host loop | Structure |
| 12 | Hierarchical topology deferred to Phase 1b | Scope |
| 13 | Research doc corrections and evaluation metrics | Docs |
| 14 | AGENT.md: roadmap, open points, toolchain | Docs |

---

## 1. Host-Native Messages via `MessageAccessor`

**What changed**: Removed the engine's own message type (`MemoryMessage`, `ContentBlock`, etc.). The engine is now generic over the host's message type `TMsg`. Message entries store host messages unchanged, and the engine reads them through a host-supplied `MessageAccessor` (origin, tool calls, tool results, text, tool-result replacement, summary message creation, optional usage/estimation).

**Why**: No single message schema fits every agent. Providers disagree on where tool results live, whether call IDs exist, whether arguments are valid JSON, and how reasoning is stored. Multi-provider agents already have their own unified type, so storing it directly avoids lossy conversion. Thinking signatures, encrypted reasoning, and provider metadata survive untouched.

**Trade-off**: a session file belongs to one host format. A session header (Phase 2) records the format and version for migrations. Provider-held history is explicitly out of scope.

**Where**: architecture §2.1, §2.2; docs §3.5; AGENT.md (capabilities, open points: the "Canonical Message Representation" item is marked resolved).

## 2. Turn Starts by Origin, Atomicity by IDs

**What changed**:
- Added `MessageOrigin` (`human | harness | model | tool | system`). A turn starts only at a `human` message (overridable with `isTurnStart`).
- Valid cut points are computed by matching tool call IDs to result IDs (`pairToolCalls` in the new `groups.ts`), not by role.

**Why**: The old rule "a user message is a clean turn boundary" breaks for Anthropic-style APIs, where tool results and harness-injected reminders arrive as user messages. It also didn't handle server-side tools, where the call and result are in the same assistant message, or aborted calls with no result.

**Where**: architecture §2.1, §3, §7.2; docs §3.2.

## 3. Rolling-Delta Start Boundary (Bug Fix)

**What changed**: A new compaction now starts at the previous compaction's `firstKeptEntryId`, not just after the previous compaction entry.

**Why**: Messages kept raw by the previous compaction were never summarized. Starting after the compaction entry meant they ended up in neither the new summary nor the new kept window, and were silently lost.

**Where**: architecture §7.1.

## 4. File Lists Stored Separately from the Summary (Bug Fix)

**What changed**: `CompactionEntry.summary` now holds only LLM-written text. File lists live in `details` and are rendered (`<read-files>`, `<modified-files>`) only when the context is built.

**Why**: Previously the file blocks were appended to `summary`, which becomes the next `<previous-summary>`. The LLM would then rewrite, duplicate, or invent paths, defeating the point of deterministic tracking.

**Where**: architecture §2.2, §5, §8.2, §9; docs §3.3.

## 5. Prompts Reworked

**What changed**:
- The summary format is a shared `SUMMARY_FORMAT` constant, included in both the initial and the update prompt. Previously the update prompt said "use the EXACT format specified in the original summary", which the model never sees.
- Prompts reference `<conversation>` / `<previous-summary>` tags instead of "the messages above"; data comes first, instructions last.
- The update prompt merges any split-turn section from the previous summary.
- The prompts tell the model not to list files (tracked separately).
- The system prompt tells the model to treat conversation content as data, not instructions.
- Added `PROMPT_VERSION`, recorded in every compaction entry.

**Where**: architecture §7.5.

## 6. `CompactionEntry` Fields

**What changed**:
- `tokensBefore` is the context size as sent to the model. It was computed over all entries, including already-summarized ones.
- Added `tokensAfter`, `reason` (`threshold | overflow | manual`), `promptVersion`, `summarizerLabel`.
- `details` is now keyed by extractor plugin name (e.g. `details.file_operations`).
- `parentId` is `string | null` (no longer optional); `timestamp` is ISO-8601 only.

**Where**: architecture §2.2, §11.

## 7. Token Measurement & Triggering (New Section)

**What changed**: Added the missing trigger and budget rules:
- `contextWindow` is passed at call time in `ModelBudget` (the model can change mid-session). It was referenced but never defined.
- Context is measured from provider-reported usage when available, adjusted for later prunes, plus estimates for newer messages; otherwise heuristic plus `overheadTokens`.
- `shouldCompact` = context > `contextWindow − reserveTokens`.
- Host loop order: micro → macro → build context → send.
- Context-overflow recovery: compact with half of `keepRecentTokens`, retry once.
- "Nothing to compact" is an explicit outcome.

**Where**: architecture §2.4, §4, §10; docs §3.8.

## 8. Micro-Compaction

**What changed**:
- Pruning decisions are saved as `prune` entries (with the exact replacement text) instead of being recomputed on every context build.
- Recency is counted in tool results (`keepRecentToolResults`), not user turns.
- Pruner adds a long-line cap (`maxLineChars`), a character hard-cut fallback, and image removal.
- Added per-tool `PruneRule`s and superseded-read eviction.
- Reactive pruning stops at `reactiveTargetRatio` of the threshold.

**Why**:
- Recomputed reactive pruning could change between requests (and un-prune after a compaction), invalidating the prompt cache.
- "Older than the active user turn" never prunes in long single-prompt agent runs.
- Line-based truncation alone doesn't shrink a single huge line.

**Where**: architecture §2.2, §2.4, §6; docs §3.1, §4A.

## 9. Summarizer

**What changed**:
- `SummarizerFn` is now text in / text out (`{ systemPrompt, prompt, maxTokens, signal }`). The engine serializes the conversation into a labelled transcript (`serializer.ts` is now specified).
- Output is validated against required headings, retried once, then fails with `invalid_summary`.
- Summaries not smaller than what they replace fail with `summary_not_smaller`.
- Histories over `maxSummarizerInputTokens` are summarized in sequential chunks; oversized turn prefixes are folded into history.
- `AbortSignal` is passed through. Added `CompactionError`; failures produce no entry.

**Why**: Sending raw tool-call messages tempts the model to continue the conversation or call tools. Failure handling, input limits, and abort were unspecified.

**Where**: architecture §2.3, §2.5, §7.3, §7.4, §7.6, §8.2.

## 10. Extractors

**What changed**:
- `ExtractorPlugin<S>` owns its own state type: `createState`, `mergePrevious`, `observe`, `serialize`, `render`. The old fixed `ExtractedState` (file fields only) is gone.
- Extractors receive `ToolObservation`s (call plus its result).
- `FileOpsExtractor` ignores failed or unanswered calls, normalizes paths, caps list size, and exposes `classify` for superseded-read detection.
- Naming unified on `ExtractorRegistry`.

**Why**: The old state was file-specific, so other plugins had no place to store data. Failed edits were counted as modifications, and paths like `src\a.ts` and `./src/a.ts` were treated as different files.

**Where**: architecture §5.

## 11. Responsibilities & Engine API

**What changed**:
- The topology decides *what* to summarize (boundary, cut point, ranges, extraction). `MacroSummarizer` only turns given messages into text. Previously the summarizer also found the previous compaction and the cut point.
- Added a `CompactionEngine` facade (`buildContext`, `measure`, `planMicro`, `shouldCompact`, `compact`) and a reference host loop.
- File layout: new `engine.ts`, `context.ts`, `tokens.ts`, `groups.ts`. The token estimator moved from `macro/estimator.ts` to `tokens.ts` (it was missing from the old tree and isn't macro-specific).

**Where**: architecture §1, §7.6, §8, §9, §10, §12.

## 12. Hierarchical Topology Deferred

**What changed**: `HierarchicalCompactor` moved from Phase 1 to Phase 1b. Its settings were removed; `topology` currently allows only `"rolling_delta"`. Preconditions for picking it up are listed.

**Why**:
- `CompactionEntry` supports a single summary and kept window, while hierarchical needs summaries covering entry ranges and several active summaries.
- Its main benefit, localized retrieval, needs a retrieval mechanism that doesn't exist.
- It can't be judged without an evaluation harness and a rolling-delta baseline.

**Where**: architecture §8.3; docs §4B; AGENT.md roadmap.

## 13. Research Doc Corrections

**What changed**:
- Codex CLI is now described correctly (LLM-based auto-compaction). Sliding window, scratchpad, and hierarchical patterns moved to a separate "Other Patterns" section.
- Claude Code findings are labelled as based on public docs and observed behavior; the "~80-90%" figure was replaced with "near the context limit".
- Added evaluation metrics (tokens saved, summarizer cost, cache hit rate, continuation quality, compactions per session).

**Where**: docs §2B–D, §4C.

## 14. AGENT.md

**What changed**:
- Capabilities mention host-native messages.
- New "Toolchain & Conventions" section (proposed, not yet confirmed).
- Docs table lists this file.
- Open points updated: the message representation is resolved; added session header/versioning, reference accessors, and toolchain confirmation.
- Roadmap reflects the new modules, adds Phase 1b, and adds the session header and path resolution to Phase 2.

---

## Still Open

- Confirm the proposed toolchain in AGENT.md before scaffolding.
- Session header format and migration (Phase 2 session spec).
- Whether to ship reference accessors, and for which host formats.
