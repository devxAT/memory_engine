import type { PruneItem } from "../types.js";
import { findPruneCandidates, toPruneEntry } from "./candidates.js";
import type { MicroContext, MicroInput, MicroStrategy } from "./types.js";

/**
 * Prunes only when the context is over the threshold: largest savings first, until the context
 * is at `threshold × reactiveTargetRatio`, so the next request does not trigger again. It may
 * touch old messages and invalidate most of the prompt cache.
 */
export class ReactiveMicroStrategy implements MicroStrategy {
  readonly name = "reactive";

  plan<TMsg>(input: MicroInput<TMsg>, ctx: MicroContext<TMsg>) {
    if (input.measured <= input.threshold) return null;

    const target = input.threshold * ctx.settings.reactiveTargetRatio;
    const candidates = findPruneCandidates(input, ctx);
    const saved = (item: PruneItem) => item.tokensBefore - item.tokensAfter;
    const chosen = new Set<PruneItem>();
    let tokens = input.measured;
    for (const item of [...candidates].sort((a, b) => saved(b) - saved(a))) {
      if (tokens <= target) break;
      chosen.add(item);
      tokens -= saved(item);
    }
    return toPruneEntry(
      this.name,
      candidates.filter((item) => chosen.has(item)),
    );
  }
}
