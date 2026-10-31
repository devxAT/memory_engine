import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CompactionEngine } from "../../src/compaction/engine.js";
import { isCompactionEntry, isPruneEntry, type ModelBudget } from "../../src/compaction/types.js";
import { SessionManager } from "../../src/session/manager.js";
import { type OaMessage, oa, oaAccessor } from "../fixtures/openai-like.js";
import { counterIds, steppingClock, useTempDir } from "../fixtures/session.js";
import { fakeSummarizer } from "../fixtures/summarizer.js";

/** The reference host loop from architecture/session.md §8. */
async function runModelRequest(
  session: SessionManager<OaMessage>,
  engine: CompactionEngine<OaMessage>,
  budget: ModelBudget,
  callModel: (context: OaMessage[]) => Promise<OaMessage>,
): Promise<OaMessage> {
  const prune = engine.planMicro(session.getEntries(), budget);
  if (prune) session.appendEntry(prune);

  if (engine.shouldCompact(session.getEntries(), budget)) {
    const outcome = await engine.compact(session.getEntries(), budget, { reason: "threshold" });
    if (outcome.status === "compacted") session.appendEntry(outcome.entry);
  }

  const reply = await callModel(engine.buildContext(session.getEntries()));
  session.appendMessage(reply);
  return reply;
}

/** `label` padded to `tokens` tokens. */
const pad = (label: string, tokens = 200) => label.padEnd(tokens * 4, ".");
const bigOutput = Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join("\n");

describe("CompactionEngine on a SessionManager", () => {
  it("compacts a persisted session; reopening and forking rebuild the same context", async () => {
    const engine = new CompactionEngine<OaMessage>({
      accessor: oaAccessor,
      summarize: fakeSummarizer(),
      settings: { reserveTokens: 2000, keepRecentTokens: 600, micro: { keepRecentToolResults: 1 } },
    });
    const budget = { contextWindow: 10_000 };
    const session = SessionManager.create<OaMessage>({
      storageRoot: useTempDir(),
      projectId: "proj",
      cwd: "/work/app",
      accessor: oaAccessor,
      generateId: counterIds(),
      now: steppingClock(),
    });
    const callModel = async () => oa.assistant(pad("answer"));

    session.appendMessage(oa.user(pad("u0")));
    await runModelRequest(session, engine, budget, callModel);
    expect(existsSync(session.getSessionFile() as string)).toBe(true); // first reply flushed

    for (let i = 1; i <= 6; i++) {
      session.appendMessage(oa.user(pad(`u${i}`)));
      for (const msg of oa.toolTurn(`c${i}`, "bash", { command: "npm test" }, bigOutput)) {
        session.appendMessage(msg);
      }
      await runModelRequest(session, engine, budget, callModel);
    }

    const entries = session.getEntries();
    expect(entries.some(isPruneEntry)).toBe(true);
    expect(entries.some(isCompactionEntry)).toBe(true);

    const context = engine.buildContext(entries);
    const reopened = SessionManager.open<OaMessage>(session.getSessionFile() as string);
    const fork = session.fork();
    const reopenedFork = SessionManager.open<OaMessage>(fork.getSessionFile() as string);

    expect(engine.buildContext(reopened.getEntries())).toEqual(context);
    expect(engine.buildContext(fork.getEntries())).toEqual(context);
    expect(engine.buildContext(reopenedFork.getEntries())).toEqual(context);
  });
});
