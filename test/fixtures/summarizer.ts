import { vi } from "vitest";
import { TURN_PREFIX_SUMMARIZATION_PROMPT } from "../../src/compaction/macro/prompts.js";
import type { SummarizeRequest } from "../../src/compaction/types.js";

/** A history summary with every required heading. `goal` tells summaries apart. */
export function historySummary(goal = "Ship it."): string {
  return [
    "## Goal",
    goal,
    "",
    "## Constraints & Preferences",
    "- (none)",
    "",
    "## Progress",
    "### Done",
    "- [x] Started",
    "",
    "### In Progress",
    "- [ ] Continue",
    "",
    "### Blocked",
    "- (none)",
    "",
    "## Key Decisions",
    "- **Keep going**: it works",
    "",
    "## Next Steps",
    "1. Finish",
    "",
    "## Critical Context",
    "- (none)",
  ].join("\n");
}

/** A turn-prefix summary with every required heading. */
export function prefixSummary(request = "Do the thing."): string {
  return [
    "## Original Request",
    request,
    "",
    "## Early Progress",
    "- Started",
    "",
    "## Context for Suffix",
    "- Keep going",
  ].join("\n");
}

export const isTurnPrefixPrompt = (request: SummarizeRequest) =>
  request.prompt.endsWith(TURN_PREFIX_SUMMARIZATION_PROMPT);

/** Answers every prompt with a valid summary numbered by call: "Summary 1", "Request 2", … */
export function fakeSummarizer() {
  let calls = 0;
  return vi.fn(async (request: SummarizeRequest) => {
    calls++;
    return isTurnPrefixPrompt(request)
      ? prefixSummary(`Request ${calls}`)
      : historySummary(`Summary ${calls}`);
  });
}
