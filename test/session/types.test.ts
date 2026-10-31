import { describe, expect, expectTypeOf, it } from "vitest";
import type { SessionEntry } from "../../src/compaction/types.js";
import {
  effectiveTitle,
  isCustomEntry,
  isTitleEntry,
  SessionError,
  type SessionHeader,
} from "../../src/session/types.js";

interface Msg {
  text: string;
}

const base = { parentId: null, timestamp: "2026-10-31T00:00:00.000Z" };
const header: SessionHeader = {
  type: "session",
  version: 1,
  id: "s1",
  timestamp: base.timestamp,
  cwd: "/work",
  title: "Initial",
};

const message: SessionEntry<Msg> = { ...base, id: "m1", type: "message", message: { text: "hi" } };
const title = (id: string, text: string): SessionEntry<Msg> => ({
  ...base,
  id,
  type: "title",
  title: text,
});
const custom: SessionEntry<Msg> = { ...base, id: "c1", type: "custom", customType: "bookmark" };

describe("entry guards", () => {
  it("match only their own entry type", () => {
    const entries = [message, title("t1", "x"), custom];
    expect(entries.map(isTitleEntry)).toEqual([false, true, false]);
    expect(entries.map(isCustomEntry)).toEqual([false, false, true]);
  });

  it("narrow SessionEntry", () => {
    const entry = title("t1", "x");
    if (isTitleEntry(entry)) expectTypeOf(entry.title).toEqualTypeOf<string>();
    if (isCustomEntry(custom)) expectTypeOf(custom.customType).toEqualTypeOf<string>();
  });
});

describe("effectiveTitle", () => {
  it("is the last title entry, or else the header title", () => {
    expect(effectiveTitle(header, [message])).toBe("Initial");
    expect(effectiveTitle(header, [title("t1", "First"), message, title("t2", "Second")])).toBe(
      "Second",
    );
    expect(effectiveTitle({ ...header, title: undefined }, [message])).toBeUndefined();
  });
});

describe("SessionError", () => {
  it("carries its code, a default message, and a cause", () => {
    const cause = new Error("disk");
    const err = new SessionError("invalid_header", undefined, { cause });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionError");
    expect(err.code).toBe("invalid_header");
    expect(err.message).toBe("invalid_header");
    expect(err.cause).toBe(cause);
  });
});
