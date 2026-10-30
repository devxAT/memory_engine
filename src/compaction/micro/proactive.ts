import { findPruneCandidates, toPruneEntry } from "./candidates.js";
import type { MicroContext, MicroInput, MicroStrategy } from "./types.js";

/**
 * Prunes every candidate on every call. Each result is pruned once, as it ages out of the
 * recent window, so only the recent tail of the prompt cache is invalidated.
 */
export class ProactiveMicroStrategy implements MicroStrategy {
  readonly name = "proactive";

  plan<TMsg>(input: MicroInput<TMsg>, ctx: MicroContext<TMsg>) {
    return toPruneEntry(this.name, findPruneCandidates(input, ctx));
  }
}
