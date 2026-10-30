import { describe, expect, it } from "vitest";
import {
  serializeBlocks,
  serializeConversation,
} from "../../../src/compaction/macro/serializer.js";
import { an, anAccessor } from "../../fixtures/anthropic-like.js";
import { oa, oaAccessor } from "../../fixtures/openai-like.js";

const opts = { maxToolResultChars: 2000 };

describe("serializeConversation", () => {
  it("labels each message by origin and separates blocks with blank lines", () => {
    const transcript = serializeConversation(
      [
        oa.system("Be terse."),
        oa.user("Read the entry point."),
        oa.harness("Tests are slow."),
        oa.assistant("Reading.", [oa.call("c1", "read", { path: "src/index.ts" })]),
        oa.tool("c1", "export {};"),
        oa.assistant(null, [oa.call("c2", "bash", { command: "npm test" })]),
        oa.tool("c2", "1 failed", true),
      ],
      oaAccessor,
      opts,
    );

    expect(transcript).toBe(
      [
        "[System]: Be terse.",
        "[User]: Read the entry point.",
        "[Harness]: Tests are slow.",
        '[Assistant]: Reading.\n[Assistant tool call] read {"path":"src/index.ts"}',
        "[Tool result: read]: export {};",
        '[Assistant tool call] bash {"command":"npm test"}',
        "[Tool result: bash (error)]: 1 failed",
      ].join("\n\n"),
    );
  });

  it("lists every result of a batched user message before its injected text", () => {
    const transcript = serializeConversation(
      [
        an.assistant([an.toolUse("t1", "ls"), an.toolUse("t2", "pwd")]),
        an.user([
          an.toolResult("t1", "a.ts"),
          an.toolResult("t2", "/repo"),
          an.text("<system-reminder>1 file changed</system-reminder>"),
        ]),
      ],
      anAccessor,
      opts,
    );

    expect(transcript).toBe(
      [
        "[Assistant tool call] ls {}\n[Assistant tool call] pwd {}",
        "[Tool result: ls]: a.ts\n[Tool result: pwd]: /repo\n" +
          "[Harness]: <system-reminder>1 file changed</system-reminder>",
      ].join("\n\n"),
    );
  });

  it("serializes a server-side call and its result from one message, without opaque content", () => {
    const transcript = serializeConversation(
      [
        an.assistant([
          an.thinking("private reasoning"),
          an.serverToolUse("s1", "web_search", { query: "vitest" }),
          an.webSearchResult("s1", [{ title: "Vitest", url: "https://vitest.dev" }]),
          an.text("Found it."),
        ]),
      ],
      anAccessor,
      opts,
    );

    expect(transcript).toBe(
      "[Assistant]: Found it.\n" +
        '[Assistant tool call] web_search {"query":"vitest"}\n' +
        "[Tool result: web_search]: Vitest https://vitest.dev",
    );
  });

  it("labels results whose call is not in the input generically", () => {
    expect(serializeConversation([oa.tool("gone", "output", true)], oaAccessor, opts)).toBe(
      "[Tool result (error)]: output",
    );
  });

  it("caps long results by keeping their head and tail", () => {
    const transcript = serializeConversation(
      [oa.tool("c1", `${"a".repeat(100)}${"b".repeat(100)}`)],
      oaAccessor,
      { maxToolResultChars: 20 },
    );

    expect(transcript).toBe(
      `[Tool result]: ${"a".repeat(10)}\n[... 180 chars truncated ...]\n${"b".repeat(10)}`,
    );
  });

  it("caps long argument strings and keeps raw arguments verbatim", () => {
    const transcript = serializeConversation(
      [
        oa.assistant(null, [oa.call("c1", "write", { content: "x".repeat(600) })]),
        oa.assistant(null, [oa.call("c2", "read", '{"path": "a.ts"')]),
      ],
      oaAccessor,
      { ...opts, maxToolArgChars: 20 },
    );

    expect(transcript).toBe(
      `[Assistant tool call] write {"content":"xxxxxxxx…[+594 chars]\n\n` +
        '[Assistant tool call] read {"path": "a.ts"',
    );
  });

  it("skips messages with nothing visible", () => {
    const blocks = serializeBlocks(
      [an.assistant([an.thinking("hmm")]), an.user("hi")],
      anAccessor,
      opts,
    );

    expect(blocks).toEqual(["[User]: hi"]);
  });
});
