import type { ExtractorPlugin, ToolObservation } from "./types.js";

export class ExtractorRegistry {
  private readonly plugins = new Map<string, ExtractorPlugin>();

  constructor(plugins: ExtractorPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  /** Names key `CompactionEntry.details`, so they must be unique. */
  register(plugin: ExtractorPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Extractor "${plugin.name}" is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): ExtractorPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Details for a new compaction. Each plugin starts from fresh state, merges its entry from
   * the previous compaction, then observes every call in order.
   */
  run(
    observations: ToolObservation[],
    previousDetails?: Record<string, unknown>,
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {};
    for (const plugin of this.plugins.values()) {
      const state = plugin.createState();
      plugin.mergePrevious(previousDetails?.[plugin.name], state);
      for (const obs of observations) plugin.observe(obs, state);
      details[plugin.name] = plugin.serialize(state);
    }
    return details;
  }

  /** Each plugin's non-empty rendering, in registration order, separated by blank lines. */
  render(details: Record<string, unknown>): string {
    const blocks: string[] = [];
    for (const plugin of this.plugins.values()) {
      const block = plugin.render(details[plugin.name]);
      if (block) blocks.push(block);
    }
    return blocks.join("\n\n");
  }
}
