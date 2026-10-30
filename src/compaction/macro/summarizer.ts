import { CHARS_PER_TOKEN } from "../tokens.js";
import {
  CompactionError,
  type CompactionSettings,
  type MessageAccessor,
  type SummarizerFn,
} from "../types.js";
import {
  buildInitialPrompt,
  buildTurnPrefixPrompt,
  buildUpdatePrompt,
  HISTORY_HEADINGS,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_HEADINGS,
} from "./prompts.js";
import { type SerializeOptions, serializeBlocks, serializeConversation } from "./serializer.js";

export interface SummaryJob<TMsg> {
  history: TMsg[];
  turnPrefix: TMsg[];
  previousSummary?: string;
  signal?: AbortSignal;
}

/** Turns given messages into summary text. Deciding what to summarize belongs to the topology. */
export class MacroSummarizer<TMsg> {
  constructor(
    private readonly summarize: SummarizerFn,
    private readonly accessor: MessageAccessor<TMsg>,
    private readonly settings: CompactionSettings,
  ) {}

  async run(job: SummaryJob<TMsg>): Promise<string> {
    const [history, prefix] = await Promise.all([
      this.summarizeHistory(job.history, job.previousSummary, job.signal),
      job.turnPrefix.length > 0
        ? this.summarizePrefix(job.turnPrefix, job.signal)
        : Promise.resolve(undefined),
    ]);
    if (!prefix) return history;
    const turnContext = `**Turn Context (split turn):**\n\n${prefix}`;
    return history ? `${history}\n\n---\n\n${turnContext}` : turnContext;
  }

  /** Folds history chunk by chunk; with no messages, the previous summary is returned unchanged. */
  private async summarizeHistory(
    messages: TMsg[],
    previous: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    let summary = previous ?? "";
    for (const transcript of this.chunk(messages)) {
      const prompt = summary
        ? buildUpdatePrompt(summary, transcript)
        : buildInitialPrompt(transcript);
      summary = await this.call(prompt, HISTORY_HEADINGS, signal);
    }
    return summary;
  }

  private summarizePrefix(messages: TMsg[], signal?: AbortSignal): Promise<string> {
    const transcript = serializeConversation(messages, this.accessor, this.serializeOptions());
    return this.call(buildTurnPrefixPrompt(transcript), TURN_PREFIX_HEADINGS, signal);
  }

  /**
   * Transcripts packed greedily, whole messages at a time, within `maxSummarizerInputTokens`.
   * A single message larger than that gets a chunk of its own.
   */
  private chunk(messages: TMsg[]): string[] {
    const limit = this.settings.maxSummarizerInputTokens * CHARS_PER_TOKEN;
    const chunks: string[] = [];
    let current = "";
    for (const block of serializeBlocks(messages, this.accessor, this.serializeOptions())) {
      const joined = current ? `${current}\n\n${block}` : block;
      if (current && joined.length > limit) {
        chunks.push(current);
        current = block;
      } else {
        current = joined;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /** One summarizer call; empty or invalid output is retried once with the same request. */
  private async call(
    prompt: string,
    headings: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      let output: string;
      try {
        output = await this.summarize({
          systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
          prompt,
          maxTokens: this.settings.summaryMaxTokens,
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new CompactionError("aborted", undefined, { cause: err });
        throw err;
      }
      throwIfAborted(signal);
      if (hasHeadings(output, headings)) return output.trim();
    }
    throw new CompactionError(
      "invalid_summary",
      `Summary is missing required sections: ${headings.join(", ")}`,
    );
  }

  private serializeOptions(): SerializeOptions {
    return { maxToolResultChars: this.settings.serializerMaxToolResultChars };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CompactionError("aborted", undefined, { cause: signal.reason });
}

function hasHeadings(output: string, headings: readonly string[]): boolean {
  const lines = new Set(output.split("\n").map((line) => line.trim()));
  return headings.every((heading) => lines.has(heading));
}
