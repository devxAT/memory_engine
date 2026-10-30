# Compaction Engine Architecture & Implementation Specification

This document provides the complete technical specification for the compaction subsystem in `memory_engine`. It is designed so that an engineering agent can implement all components directly.

---

## 1. Subsystem Overview & Directory Structure

The compaction engine lives under `src/compaction/` and is divided into five functional modules:

```
src/compaction/
├── types.ts                    # Core compaction data models, messages, and injected interfaces
├── extractors/                 # Pluggable deterministic state extraction
│   ├── types.ts                # ExtractorPlugin, ExtractionRegistry interfaces
│   ├── registry.ts             # Extractor registry implementation
│   └── file-ops.ts             # Pluggable file operations extractor
├── micro/                      # Stage 1: Fast deterministic tool output pruner
│   ├── types.ts                # MicroCompactionStrategy, PruneRule interfaces
│   ├── pruner.ts               # Content truncator and eviction stub generator
│   ├── proactive.ts            # ProactiveMicroStrategy (sliding window / per-turn)
│   └── reactive.ts             # ReactiveMicroStrategy (triggered by token pressure)
├── macro/                      # Stage 2: Semantic LLM summarization
│   ├── cut-point.ts            # Atomic cut point & split-turn boundary detector
│   ├── prompts.ts              # Markdown schema templates & prompt builders
│   ├── summarizer.ts           # Orchestrator invoking injected host LLM function
│   └── serializer.ts          # Conversation serializer for LLM prompts
└── topology/                   # Compaction structure strategies
    ├── types.ts                # CompactionTopology interface
    ├── rolling-delta.ts        # RollingDeltaCompactor (Pi-style single updated checkpoint)
    └── hierarchical.ts         # HierarchicalCompactor (chunked summary tree)
```

---

## 2. Core Types & Injected Interfaces (`src/compaction/types.ts`)

```typescript
// ============================================================================
// Canonical Message & Tool Types
// ============================================================================

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface MemoryMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "tool" | "compactionSummary";
  content: string | ContentBlock[];
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Session Entry Base & Compaction Entry
// ============================================================================

export interface SessionEntryBase {
  id: string;
  parentId?: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: MemoryMessage;
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  custom?: Record<string, unknown>;
}

export interface CompactionEntry<T = CompactionDetails> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: T;
}

export type SessionEntry = MessageEntry | CompactionEntry | (SessionEntryBase & { type: string; [key: string]: unknown });

// ============================================================================
// Injected Host Dependencies
// ============================================================================

export interface SummarizeOptions {
  systemPrompt?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Host agent provides this function to execute LLM summarization.
 * The memory engine never imports or invokes LLM SDKs directly.
 */
export type SummarizerFn = (
  messages: MemoryMessage[],
  options: SummarizeOptions
) => Promise<string>;

/**
 * Optional token estimation callback provided by host.
 * If omitted, default heuristic (Math.ceil(chars / 4)) is used.
 */
export type TokenEstimatorFn = (message: MemoryMessage) => number;

// ============================================================================
// Compaction Configuration
// ============================================================================

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;        // Safety buffer below model context limit (e.g., 16384)
  keepRecentTokens: number;     // Target tokens to retain in raw form (e.g., 20000)
  microCompaction: {
    strategy: "proactive" | "reactive";
    maxToolResultTokens: number; // Max size for single tool result before truncation (e.g., 1000)
    preserveHeadLines: number;   // Lines to keep at top of truncated tool result (e.g., 20)
    preserveTailLines: number;   // Lines to keep at bottom of truncated tool result (e.g., 20)
  };
  topology: "rolling_delta" | "hierarchical";
  hierarchical?: {
    chunkSizeTurns: number;      // Number of turns per chunk (e.g., 10)
    maxLevel1Summaries: number;  // Level 1 summaries before rolling into Level 2 (e.g., 5)
  };
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  microCompaction: {
    strategy: "proactive",
    maxToolResultTokens: 1000,
    preserveHeadLines: 20,
    preserveTailLines: 20,
  },
  topology: "rolling_delta",
};
```

---

## 3. Pluggable Deterministic Extraction (`src/compaction/extractors/`)

### Architecture
Deterministic extraction scans tool calls directly from message history to track state (e.g., files read and modified) without relying on LLM summarization. Because host agents use differing tool names (e.g., `read`, `read_file`, `View`), extractors are configurable plugins.

### Interfaces (`src/compaction/extractors/types.ts`)
```typescript
import type { MemoryMessage, SessionEntry } from "../types.js";

export interface ExtractedState {
  readFiles: Set<string>;
  writtenFiles: Set<string>;
  editedFiles: Set<string>;
  metadata: Record<string, unknown>;
}

export interface ExtractorPlugin {
  name: string;
  extractFromMessage(message: MemoryMessage, state: ExtractedState): void;
  mergeFromPrevious(previousDetails: unknown, state: ExtractedState): void;
  formatForSummary(state: ExtractedState): string;
}
```

### Configurable File Operations Extractor (`src/compaction/extractors/file-ops.ts`)
```typescript
export interface FileOpsConfig {
  readTools: string[];         // e.g. ["read", "read_file", "view"]
  writeTools: string[];        // e.g. ["write", "write_file", "create"]
  editTools: string[];         // e.g. ["edit", "str_replace_editor", "patch"]
  pathArgKeys: string[];       // e.g. ["path", "file_path", "filePath", "file"]
}

export const DEFAULT_FILE_OPS_CONFIG: FileOpsConfig = {
  readTools: ["read", "read_file", "view"],
  writeTools: ["write", "write_file", "create"],
  editTools: ["edit", "str_replace_editor", "patch"],
  pathArgKeys: ["path", "file_path", "filePath", "file"],
};

export class FileOpsExtractor implements ExtractorPlugin {
  name = "file_operations";
  constructor(private config: FileOpsConfig = DEFAULT_FILE_OPS_CONFIG) {}

  extractFromMessage(message: MemoryMessage, state: ExtractedState): void {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = this.extractPath(block.arguments);
      if (!path) continue;

      if (this.config.readTools.includes(block.name)) state.readFiles.add(path);
      else if (this.config.writeTools.includes(block.name)) state.writtenFiles.add(path);
      else if (this.config.editTools.includes(block.name)) state.editedFiles.add(path);
    }
  }

  mergeFromPrevious(previousDetails: any, state: ExtractedState): void {
    if (!previousDetails) return;
    if (Array.isArray(previousDetails.readFiles)) {
      for (const f of previousDetails.readFiles) state.readFiles.add(f);
    }
    if (Array.isArray(previousDetails.modifiedFiles)) {
      for (const f of previousDetails.modifiedFiles) state.editedFiles.add(f);
    }
  }

  formatForSummary(state: ExtractedState): string {
    const modified = new Set([...state.writtenFiles, ...state.editedFiles]);
    const readOnly = [...state.readFiles].filter((f) => !modified.has(f)).sort();
    const modifiedList = [...modified].sort();

    const sections: string[] = [];
    if (readOnly.length > 0) sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
    if (modifiedList.length > 0) sections.push(`<modified-files>\n${modifiedList.join("\n")}\n</modified-files>`);
    return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
  }

  private extractPath(args: Record<string, unknown>): string | undefined {
    for (const key of this.config.pathArgKeys) {
      if (typeof args[key] === "string") return args[key] as string;
    }
    return undefined;
  }
}
```

---

## 4. Stage 1: Micro-Compaction (`src/compaction/micro/`)

### Purpose
Micro-compaction strips excess tokens from bulky tool outputs (compiler dumps, file reads, grep searches) without calling an LLM.

### Truncation Specification (`src/compaction/micro/pruner.ts`)
When a tool result exceeds `maxToolResultTokens`:
1. Preserve the first $N$ lines (`preserveHeadLines`).
2. Preserve the last $M$ lines (`preserveTailLines`).
3. Replace the middle with an informative eviction stub:
   `\n[... truncated ${omittedLines} lines / ${omittedChars} chars: original size ${totalLines} lines ...]\n`
4. Never modify raw JSONL files on disk. Micro-compaction operates on in-memory message arrays during turn processing or context hydration.

### Strategies
- **`ProactiveMicroStrategy` (`src/compaction/micro/proactive.ts`)**:
  - Traverses messages. For all tool results older than the active user turn, if they exceed `maxToolResultTokens`, truncates them immediately.
- **`ReactiveMicroStrategy` (`src/compaction/micro/reactive.ts`)**:
  - Checks if total context > `contextWindow - reserveTokens`.
  - Only if true, sorts older tool results by size descending and prunes the largest results until the token budget is restored or all candidates are pruned.

---

## 5. Stage 2: Macro-Compaction (`src/compaction/macro/`)

### 1. Atomic Cut-Point Algorithm (`src/compaction/macro/cut-point.ts`)

```
Entries: [Turn 1 (U1, A1)] -> [Turn 2 (U2, A2-ToolCall, A2-ToolResult, A3)] -> [Turn 3 (U3...)]
                                     ▲
                              Valid Cut Point (Never between ToolCall & ToolResult)
```

#### Invariants:
1. **Tool Atomicity**: A cut point can be a user message or an assistant message. It can **never** be placed at a `toolResult`. When cutting at an assistant message containing tool calls, its corresponding `toolResults` immediately follow and are preserved in the kept window.
2. **Reverse Accumulation**:
   - Start from the latest entry and walk backward toward the earliest uncompacted boundary.
   - Accumulate tokens using `estimateTokens(message)`.
   - When `accumulatedTokens >= keepRecentTokens`, locate the nearest valid cut point at or after this index.
3. **Turn Splitting**:
   - If the cut point is a user message (`role === "user"`), it is a clean turn boundary (`isSplitTurn = false`).
   - If the cut point is an assistant message inside a multi-step tool turn, `isSplitTurn = true`.
   - Trace backward to find `turnStartIndex` (the user message that originated the active turn).

```typescript
export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  estimateTokens: TokenEstimatorFn
): CutPointResult;
```

---

### 2. Prompt Templates (`src/compaction/macro/prompts.ts`)

#### System Prompt (`SUMMARIZATION_SYSTEM_PROMPT`):
```markdown
You are an expert context compaction engine. Your job is to generate a structured, factual checkpoint summary of past conversation turns. You must preserve exact file paths, function names, error codes, and architectural constraints. Do not invent facts or extrapolate beyond the provided conversation.
```

#### Initial Summarization Prompt (`SUMMARIZATION_PROMPT`):
```markdown
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

#### Delta Update Prompt (`UPDATE_SUMMARIZATION_PROMPT`):
```markdown
The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the EXACT format specified in the original summary.
```

#### Split-Turn Prefix Prompt (`TURN_PREFIX_SUMMARIZATION_PROMPT`):
```markdown
This is the PREFIX of an active turn that was too large to keep in full. The SUFFIX (recent work) is retained in the active context.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what is needed to understand the kept suffix.
```

---

### 3. Summarizer Orchestrator (`src/compaction/macro/summarizer.ts`)

```typescript
export interface MacroCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: CompactionDetails;
}

export class MacroSummarizer {
  constructor(
    private summarizerFn: SummarizerFn,
    private extractorRegistry: ExtractorRegistry,
    private estimateTokens: TokenEstimatorFn
  ) {}

  async execute(
    entries: SessionEntry[],
    settings: CompactionSettings,
    previousCompaction?: CompactionEntry
  ): Promise<MacroCompactionResult> {
    // 1. Calculate cut point
    const startIndex = previousCompaction ? entries.findIndex(e => e.id === previousCompaction.id) + 1 : 0;
    const cut = findCutPoint(entries, startIndex, entries.length, settings.keepRecentTokens, this.estimateTokens);

    const firstKeptEntry = entries[cut.firstKeptEntryIndex];
    const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;

    const messagesToSummarize = this.extractMessages(entries, startIndex, historyEnd);
    const turnPrefixMessages = cut.isSplitTurn ? this.extractMessages(entries, cut.turnStartIndex, cut.firstKeptEntryIndex) : [];

    // 2. Extract deterministic state
    const state = this.extractorRegistry.createInitialState();
    if (previousCompaction?.details) {
      this.extractorRegistry.mergeFromPrevious(previousCompaction.details, state);
    }
    for (const msg of [...messagesToSummarize, ...turnPrefixMessages]) {
      this.extractorRegistry.extractFromMessage(msg, state);
    }

    // 3. Generate summary via injected LLM summarizer
    let finalSummary = "";
    if (cut.isSplitTurn && turnPrefixMessages.length > 0) {
      const [historySummary, prefixSummary] = await Promise.all([
        this.runHistorySummary(messagesToSummarize, previousCompaction?.summary),
        this.runPrefixSummary(turnPrefixMessages),
      ]);
      finalSummary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;
    } else {
      finalSummary = await this.runHistorySummary(messagesToSummarize, previousCompaction?.summary);
    }

    // 4. Append deterministic state blocks
    finalSummary += this.extractorRegistry.formatForSummary(state);

    return {
      summary: finalSummary,
      firstKeptEntryId: firstKeptEntry.id,
      tokensBefore: this.calculateTokensBefore(entries),
      details: {
        readFiles: [...state.readFiles],
        modifiedFiles: [...new Set([...state.writtenFiles, ...state.editedFiles])],
      },
    };
  }
}
```

---

## 6. Compaction Topologies (`src/compaction/topology/`)

### Interface (`src/compaction/topology/types.ts`)
```typescript
export interface CompactionTopology {
  readonly name: "rolling_delta" | "hierarchical";
  compact(
    entries: SessionEntry[],
    settings: CompactionSettings,
    summarizer: MacroSummarizer
  ): Promise<CompactionEntry>;
}
```

### 1. `RollingDeltaCompactor` (`src/compaction/topology/rolling-delta.ts`)
- Locates the latest existing `CompactionEntry` in the current branch.
- Performs cut-point calculation between the previous compaction and the end of history.
- Passes `previousCompaction.summary` to the delta update prompt.
- Produces a single new `CompactionEntry` that supersedes the prior one. When hydrating session context, only the latest compaction summary is emitted.

### 2. `HierarchicalCompactor` (`src/compaction/topology/hierarchical.ts`)
- Segments conversation history into chunk blocks of $N$ turns (e.g. 10 turns per chunk).
- When a chunk completes, creates a **Level 1 Chunk Summary**.
- When the count of Level 1 summaries reaches `maxLevel1Summaries` (e.g. 5), creates a **Level 2 Milestone Summary** combining the Level 1 summaries.
- Hydration emits the Level 2 summary + any active Level 1 summaries + recent raw turns.

---

## 7. Storage Integration & Hydration Lifecycle

### Appending Compaction to JSONL
A compaction event is written as a standard line in the session JSONL:
```json
{
  "type": "compaction",
  "id": "comp-7f8e",
  "parentId": "msg-04b2",
  "timestamp": "2026-10-30T23:30:00.000Z",
  "summary": "## Goal\nImplement compaction...",
  "firstKeptEntryId": "msg-0490",
  "tokensBefore": 184500,
  "details": {
    "readFiles": ["src/index.ts"],
    "modifiedFiles": ["src/compaction/pruner.ts"]
  }
}
```

### Context Hydration Algorithm
To produce the message array sent to the LLM:
1. Walk the branch from leaf to root to collect active path entries.
2. Locate the active `CompactionEntry`.
   - If found:
     - Prepend `summary` as the first message (`role: "compactionSummary"` or formatted system block).
     - Include all kept entries starting from `firstKeptEntryId` up to the compaction entry.
     - Include all entries recorded after the compaction entry.
   - If not found:
     - Include all messages in the branch.
3. Apply active `MicroCompactionStrategy` to prune oversized tool results from the assembled message list.

---

## 8. Agent Implementation Guide

When an agent is tasked with building this subsystem, follow this execution sequence:

1. **Step 1: Core Types** (`src/compaction/types.ts`): Implement messages, entries, `CompactionSettings`, and injected dependency signatures.
2. **Step 2: Token Estimator** (`src/compaction/macro/estimator.ts`): Implement default heuristic (`Math.ceil(chars / 4)` with image/tool handling) and callback wrapper.
3. **Step 3: Pluggable Extractors** (`src/compaction/extractors/*`): Implement `ExtractorPlugin`, `FileOpsExtractor`, and `ExtractorRegistry`. Write unit tests with mock tool calls.
4. **Step 4: Micro-Compaction** (`src/compaction/micro/*`): Implement `pruner.ts` (head/tail preservation and eviction stub), then `proactive.ts` and `reactive.ts`. Unit test against 5,000-line tool outputs.
5. **Step 5: Macro Cut-Point & Turn Detector** (`src/compaction/macro/cut-point.ts`): Implement `findCutPoint`, `findTurnStartIndex`, and boundary tests ensuring no toolResult splits.
6. **Step 6: Macro Summarizer** (`src/compaction/macro/summarizer.ts`): Implement orchestrator using injected `SummarizerFn` and test prompts.
7. **Step 7: Compaction Topologies** (`src/compaction/topology/*`): Implement `RollingDeltaCompactor` and `HierarchicalCompactor`.
8. **Step 8: Context Assembler Integration**: Connect hydration logic ensuring summaries and kept windows assemble correctly into LLM context.
