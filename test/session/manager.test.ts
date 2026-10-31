import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { NewEntry, PruneEntry } from "../../src/compaction/types.js";
import { SessionManager } from "../../src/session/manager.js";
import { sessionsDir } from "../../src/session/paths.js";
import type { OpenOptions, SessionConfig } from "../../src/session/types.js";
import { type OaMessage, oa, oaAccessor } from "../fixtures/openai-like.js";
import { counterIds, readJsonl, steppingClock, useTempDir } from "../fixtures/session.js";

const code = (c: string) => expect.objectContaining({ code: c });

function create(root: string, config: Partial<SessionConfig<OaMessage>> = {}) {
  return SessionManager.create<OaMessage>({
    storageRoot: root,
    projectId: "proj",
    cwd: "/work/app",
    generateId: counterIds(),
    now: steppingClock(),
    ...config,
  });
}

/** A flushed session with a user prompt and a model reply. */
function flushed(root: string, config: Partial<SessionConfig<OaMessage>> = {}) {
  const session = create(root, { accessor: oaAccessor, ...config });
  session.appendMessage(oa.user("hi"));
  session.appendMessage(oa.assistant("hello"));
  return session;
}

const open = (file: string | undefined, options: OpenOptions<OaMessage> = {}) =>
  SessionManager.open<OaMessage>(file as string, { generateId: counterIds("re"), ...options });

const fileOf = (session: SessionManager<OaMessage>) => session.getSessionFile() as string;

const prune: NewEntry<PruneEntry> = {
  type: "prune",
  strategy: "proactive",
  items: [{ toolCallId: "c1", replacement: "[pruned]", tokensBefore: 100, tokensAfter: 5 }],
};

describe("SessionManager.create", () => {
  it("builds the header in memory and fixes the file path without writing", () => {
    const root = useTempDir();
    const session = create(root, { title: "T", metadata: { branch: "main" } });

    expect(session.getHeader()).toEqual({
      type: "session",
      version: 1,
      id: "id-1",
      timestamp: "2026-10-31T00:00:00.000Z",
      cwd: "/work/app",
      title: "T",
      metadata: { branch: "main" },
    });
    expect(session.getId()).toBe("id-1");
    expect(session.getSessionFile()).toBe(
      join(sessionsDir(root, "proj"), "2026-10-31T00-00-00-000Z_id-1.jsonl"),
    );
    expect(session.isFlushed()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects an invalid projectId", () => {
    expect(() => create(useTempDir(), { projectId: "../escape" })).toThrow(
      code("invalid_project_id"),
    );
  });
});

describe("appending", () => {
  it("chains entries through parentId with generated IDs and timestamps", () => {
    const session = create(useTempDir());
    const first = session.appendMessage(oa.user("a"));
    const second = session.appendMessage(oa.assistant("b"));

    expect(first).toEqual({
      type: "message",
      id: "id-2",
      parentId: null,
      timestamp: "2026-10-31T00:00:01.000Z",
      message: oa.user("a"),
    });
    expect(second).toMatchObject({ id: "id-3", parentId: "id-2" });
    expect(session.getEntries()).toEqual([first, second]);
    expect(session.getLeafEntry()).toBe(second);
  });

  it("returns a copy of the entries", () => {
    const session = create(useTempDir());
    session.appendMessage(oa.user("a"));

    session.getEntries().pop();

    expect(session.getEntries()).toHaveLength(1);
  });

  it("writes base fields first and ignores any the caller passes", () => {
    const session = flushed(useTempDir());
    const entry = session.appendEntry({ type: "custom", customType: "x", id: "mine" });

    expect(entry.id).not.toBe("mine");
    expect(Object.keys(readJsonl(fileOf(session)).at(-1) ?? {})).toEqual([
      "type",
      "id",
      "parentId",
      "timestamp",
      "customType",
    ]);
  });

  it("appendEntry accepts engine output and custom entries, typed by their input", () => {
    const session = create(useTempDir());
    const pruned = session.appendEntry(prune);
    const bookmark = session.appendEntry({
      type: "custom",
      customType: "bookmark",
      data: { label: "v1" },
    });

    expect(pruned).toMatchObject({ type: "prune", parentId: null });
    expect(bookmark).toMatchObject({ type: "custom", parentId: pruned.id });
    expectTypeOf(pruned.items).toEqualTypeOf<PruneEntry["items"]>();
    expectTypeOf(bookmark.data.label).toEqualTypeOf<string>();
  });

  it("appendEntry rejects types that have their own method", () => {
    const session = create(useTempDir());
    for (const type of ["message", "title", "session"]) {
      expect(() => session.appendEntry({ type })).toThrow(code("invalid_entry"));
    }
    expect(session.getEntries()).toEqual([]);
  });
});

describe("delayed flush", () => {
  it("writes nothing until the first model message, then the whole buffer", () => {
    const session = create(useTempDir(), { accessor: oaAccessor });
    session.appendMessage(oa.system("rules"));
    session.appendMessage(oa.user("hi"));
    session.appendMessage(oa.harness("reminder"));
    session.appendEntry({ type: "custom", customType: "model_change" });

    expect(existsSync(fileOf(session))).toBe(false);

    session.appendMessage(oa.assistant("hello"));

    expect(session.isFlushed()).toBe(true);
    expect(readJsonl(fileOf(session))).toEqual([session.getHeader(), ...session.getEntries()]);
  });

  it("appends each entry once flushed", () => {
    const session = flushed(useTempDir());
    session.appendMessage(oa.user("more"));
    session.setTitle("Named");

    expect(readJsonl(fileOf(session))).toEqual([session.getHeader(), ...session.getEntries()]);
  });

  it("never inspects messages without an accessor; only flush() writes", () => {
    const session = create(useTempDir());
    session.appendMessage(oa.user("hi"));
    session.appendMessage(oa.assistant("hello"));

    expect(session.isFlushed()).toBe(false);

    session.flush();
    session.flush(); // no-op

    expect(readJsonl(fileOf(session))).toHaveLength(3);
  });

  it("keeps a failed flush buffered, without overwriting, and retries on the next flush", () => {
    const root = useTempDir();
    const session = create(root, { accessor: oaAccessor });
    session.appendMessage(oa.user("hi"));
    // Same IDs and clock, so the same path: occupy it.
    create(root).flush();
    expect(existsSync(fileOf(session))).toBe(true);

    expect(() => session.appendMessage(oa.assistant("hello"))).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(session.isFlushed()).toBe(false);
    expect(session.getEntries()).toHaveLength(2);
    expect(readJsonl(fileOf(session))).toHaveLength(1); // the other session's header only

    rmSync(fileOf(session));
    session.flush();

    expect(readJsonl(fileOf(session))).toEqual([session.getHeader(), ...session.getEntries()]);
  });

  it("writes before committing, so a failed append leaves memory unchanged", () => {
    const root = useTempDir();
    const session = flushed(root);
    rmSync(root, { recursive: true, force: true });

    expect(() => session.appendMessage(oa.user("lost"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(session.getEntries()).toHaveLength(2);
  });
});

describe("in-memory sessions", () => {
  it("never touch the disk", () => {
    const root = useTempDir();
    const session = create(root, { persist: false, accessor: oaAccessor });
    session.appendMessage(oa.user("hi"));
    session.appendMessage(oa.assistant("hello"));
    session.flush();
    session.fork();

    expect(session.getSessionFile()).toBeUndefined();
    expect(session.isFlushed()).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("titles", () => {
  it("are appended as entries; the last one wins over the header", () => {
    const session = create(useTempDir(), { title: "Initial" });
    expect(session.getTitle()).toBe("Initial");

    const entry = session.setTitle("First");
    session.setTitle("Second");

    expect(entry).toMatchObject({ type: "title", title: "First" });
    expect(session.getTitle()).toBe("Second");
    expect(session.getHeader().title).toBe("Initial");
  });
});

describe("SessionManager.open", () => {
  it("round-trips header and entries, and continues the chain", () => {
    const session = flushed(useTempDir(), { title: "T", messageFormat: "oa@1" });
    session.setTitle("Renamed");

    const reopened = open(session.getSessionFile());

    expect(reopened.getHeader()).toEqual(session.getHeader());
    expect(reopened.getEntries()).toEqual(session.getEntries());
    expect(reopened.getTitle()).toBe("Renamed");
    expect(reopened.isFlushed()).toBe(true);

    const next = reopened.appendMessage(oa.user("again"));

    expect(next.parentId).toBe(session.getLeafEntry()?.id);
    expect(open(session.getSessionFile()).getEntries()).toEqual(reopened.getEntries());
  });

  it("drops a torn last line and truncates it before appending", () => {
    const session = flushed(useTempDir());
    const file = fileOf(session);
    writeFileSync(file, '{"type":"message","id":"torn', { flag: "a" });

    const reopened = open(file);
    expect(reopened.getEntries()).toEqual(session.getEntries());

    reopened.appendMessage(oa.user("after crash"));

    expect(open(file).getEntries()).toHaveLength(3);
  });

  it("with persist: false, never writes to the file", () => {
    const session = flushed(useTempDir());
    const file = fileOf(session);
    writeFileSync(file, '{"torn', { flag: "a" });
    const before = readFileSync(file, "utf8");

    const readOnly = open(file, { persist: false });
    readOnly.appendMessage(oa.user("memory only"));
    readOnly.setTitle("x");
    const child = readOnly.fork();

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readOnly.getSessionFile()).toBe(file);
    expect(child.getSessionFile()).toBeUndefined();
    expect(readdirSync(join(file, ".."))).toHaveLength(1);
  });

  it("refuses files written by a newer engine", () => {
    const session = flushed(useTempDir());
    const file = fileOf(session);
    const [header, ...entries] = readJsonl(file);
    writeFileSync(
      file,
      [{ ...header, version: 2 }, ...entries].map((l) => `${JSON.stringify(l)}\n`).join(""),
    );

    expect(() => open(file)).toThrow(code("unsupported_version"));
  });

  describe("message format", () => {
    const v2 = (msg: unknown): OaMessage => {
      const m = msg as OaMessage;
      return m.role === "user" ? { ...m, content: `[v2] ${m.content}` } : m;
    };

    it("is not checked when no format is expected", () => {
      const session = flushed(useTempDir(), { messageFormat: "oa@1" });
      expect(open(session.getSessionFile()).getEntries()).toEqual(session.getEntries());
    });

    it("throws on a mismatch without upgradeMessage", () => {
      const session = flushed(useTempDir(), { messageFormat: "oa@1" });
      expect(() => open(session.getSessionFile(), { messageFormat: "oa@2" })).toThrow(
        code("message_format_mismatch"),
      );
    });

    it("upgrades every message and rewrites the file with the new format", () => {
      const session = flushed(useTempDir(), { messageFormat: "oa@1" });
      session.appendEntry(prune);
      const calls: unknown[] = [];

      const upgraded = open(session.getSessionFile(), {
        messageFormat: "oa@2",
        upgradeMessage: (msg, from) => {
          calls.push(from);
          return v2(msg);
        },
      });

      expect(calls).toEqual(["oa@1", "oa@1"]);
      expect(upgraded.getHeader().messageFormat).toBe("oa@2");
      expect(upgraded.getEntries()[0]).toMatchObject({ message: oa.user("[v2] hi") });
      expect(upgraded.getEntries()[2]).toEqual(session.getEntries()[2]); // not a message

      // The rewrite happened before any append: reopening needs no upgrade.
      const again = open(session.getSessionFile(), { messageFormat: "oa@2" });
      expect(again.getEntries()).toEqual(upgraded.getEntries());
    });

    it("leaves the file untouched when opened with persist: false", () => {
      const session = flushed(useTempDir(), { messageFormat: "oa@1" });
      const before = readFileSync(fileOf(session), "utf8");

      open(session.getSessionFile(), { persist: false, messageFormat: "oa@2", upgradeMessage: v2 });

      expect(readFileSync(fileOf(session), "utf8")).toBe(before);
    });
  });
});

describe("fork", () => {
  it("copies the entries verbatim into a new file linked to the parent", () => {
    const parent = flushed(useTempDir(), {
      title: "Parent",
      messageFormat: "oa@1",
      metadata: { branch: "main", model: "m1" },
    });
    parent.appendEntry(prune);
    const parentFile = readFileSync(fileOf(parent), "utf8");

    const child = parent.fork(undefined, { cwd: "/work/other", metadata: { model: "m2" } });

    expect(child.getEntries()).toEqual(parent.getEntries()); // same IDs
    expect(child.getHeader()).toEqual({
      type: "session",
      version: 1,
      id: child.getId(),
      timestamp: expect.any(String),
      cwd: "/work/other",
      messageFormat: "oa@1",
      title: "Parent",
      parentSessionId: parent.getId(),
      forkedFromEntryId: parent.getLeafEntry()?.id,
      metadata: { branch: "main", model: "m2" },
    });
    expect(child.getId()).not.toBe(parent.getId());
    expect(child.isFlushed()).toBe(true);
    expect(readJsonl(fileOf(child))).toEqual([child.getHeader(), ...child.getEntries()]);
    expect(readFileSync(fileOf(parent), "utf8")).toBe(parentFile);
  });

  it("stops at the target entry, and the two sessions grow independently", () => {
    const parent = flushed(useTempDir());
    const [prompt] = parent.getEntries();

    const child = parent.fork(prompt.id);
    child.appendMessage(oa.assistant("another answer"));
    parent.appendMessage(oa.user("next"));

    expect(child.getHeader().forkedFromEntryId).toBe(prompt.id);
    expect(child.getEntries().map((e) => e.parentId)).toEqual([null, prompt.id]);
    expect(open(fileOf(child)).getEntries()).toHaveLength(2);
    expect(open(fileOf(parent)).getEntries()).toHaveLength(3);
  });

  it("throws entry_not_found for an unknown target or an empty session", () => {
    const root = useTempDir();
    expect(() => flushed(root).fork("nope")).toThrow(code("entry_not_found"));
    expect(() => create(root).fork()).toThrow(code("entry_not_found"));
  });

  it("flushes an unflushed parent first so the link names an existing file", () => {
    const parent = create(useTempDir());
    parent.appendMessage(oa.user("hi"));

    const child = parent.fork();

    expect(parent.isFlushed()).toBe(true);
    expect(existsSync(fileOf(parent))).toBe(true);
    expect(child.getHeader().parentSessionId).toBe(parent.getId());
  });

  it("inherits the parent's title at the fork point unless a title is given", () => {
    const parent = flushed(useTempDir(), { title: "Header title" });
    const [prompt] = parent.getEntries();
    parent.setTitle("Renamed");

    expect(parent.fork(prompt.id).getTitle()).toBe("Header title");
    expect(parent.fork().getTitle()).toBe("Renamed");

    const named = parent.fork(undefined, { title: "Fork" });
    expect(named.getTitle()).toBe("Fork");
    expect(named.getLeafEntry()).toMatchObject({ type: "title", title: "Fork" });
    expect(open(fileOf(named)).getTitle()).toBe("Fork");
  });
});
