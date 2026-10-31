import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteSession,
  findMostRecent,
  listSessions,
  renameSession,
  searchSessions,
} from "../../src/session/discovery.js";
import { SessionManager } from "../../src/session/manager.js";
import { sessionIdFromFileName, sessionsDir } from "../../src/session/paths.js";
import type { SessionConfig, SessionDiscoveryConfig } from "../../src/session/types.js";
import { type OaMessage, oa, oaAccessor } from "../fixtures/openai-like.js";
import { counterIds, readJsonl, steppingClock, useTempDir } from "../fixtures/session.js";

/** A flushed session whose clock starts at `minute`, so sessions sort predictably. */
function stored(
  root: string,
  name: string,
  minute: number,
  messages: OaMessage[] = [oa.user(`${name} prompt`), oa.assistant(`${name} answer`)],
  config: Partial<SessionConfig<OaMessage>> = {},
) {
  const session = SessionManager.create<OaMessage>({
    storageRoot: root,
    projectId: "proj",
    cwd: `/work/${name}`,
    generateId: counterIds(name),
    now: steppingClock(minute),
    ...config,
  });
  for (const msg of messages) session.appendMessage(msg);
  session.flush();
  return session;
}

const discovery = (root: string, withAccessor = true): SessionDiscoveryConfig<OaMessage> => ({
  storageRoot: root,
  projectId: "proj",
  accessor: withAccessor ? oaAccessor : undefined,
});

describe("listSessions", () => {
  it("is empty when the project has no sessions directory", async () => {
    expect(await listSessions(discovery(useTempDir()))).toEqual([]);
  });

  it("summarizes each session, most recently modified first", async () => {
    const root = useTempDir();
    const old = stored(root, "old", 0, [
      oa.system("rules"),
      oa.harness("reminder"),
      oa.user([oa.image()]), // no text: not a preview
      oa.user(`  Fix   the\nlogin ${"x".repeat(200)}`),
      oa.assistant("done"),
    ]);
    old.setTitle("Login fix");
    const recent = stored(root, "recent", 5);

    const [first, second] = await listSessions(discovery(root));

    expect(first).toMatchObject({ id: recent.getId(), preview: "recent prompt", title: null });
    expect(second).toEqual({
      id: old.getId(),
      path: old.getSessionFile(),
      title: "Login fix",
      cwd: "/work/old",
      created: new Date("2026-10-31T00:00:00.000Z"),
      modified: new Date(old.getLeafEntry()?.timestamp as string),
      messageCount: 5,
      preview: `Fix the login ${"x".repeat(136)}`,
      parentSessionId: undefined,
    });
    expect(second.preview).toHaveLength(150);
  });

  it("sorts by the last entry, not by creation", async () => {
    const root = useTempDir();
    const early = stored(root, "early", 0);
    stored(root, "late", 5);

    // The session created first gets the latest entry.
    SessionManager.open<OaMessage>(early.getSessionFile() as string, {
      now: steppingClock(10),
    }).appendMessage(oa.user("later"));

    const ids = (await listSessions(discovery(root))).map((s) => s.id);
    expect(ids).toEqual([early.getId(), "late-1"]);
  });

  it("has null previews without an accessor, and links forks to their parent", async () => {
    const root = useTempDir();
    const parent = stored(root, "parent", 0);
    const fork = parent.fork();

    const summaries = await listSessions(discovery(root, false));

    expect(summaries.map((s) => s.preview)).toEqual([null, null]);
    expect(summaries.find((s) => s.id === fork.getId())?.parentSessionId).toBe(parent.getId());
  });

  it("skips invalid files and other names, and ignores torn last lines", async () => {
    const root = useTempDir();
    const good = stored(root, "good", 0);
    const dir = sessionsDir(root, "proj");
    writeFileSync(join(dir, "garbage.jsonl"), "not json\nat all\n");
    writeFileSync(join(dir, "empty.jsonl"), "");
    writeFileSync(
      join(dir, "future.jsonl"),
      `${JSON.stringify({ type: "session", version: 99, id: "f", timestamp: "t", cwd: "/" })}\n`,
    );
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(good.getSessionFile() as string, '{"type":"mess', { flag: "a" });

    const summaries = await listSessions(discovery(root));

    expect(summaries.map((s) => s.id)).toEqual([good.getId()]);
    expect(summaries[0].messageCount).toBe(2);
  });

  it("rejects an invalid projectId", async () => {
    await expect(listSessions({ storageRoot: useTempDir(), projectId: ".." })).rejects.toThrow(
      expect.objectContaining({ code: "invalid_project_id" }),
    );
  });
});

describe("searchSessions", () => {
  it("matches titles and, with an accessor, message text, case-insensitively", async () => {
    const root = useTempDir();
    const titled = stored(root, "titled", 0);
    titled.setTitle("Refactor PARSER");
    const content = stored(root, "content", 5, [oa.user("why is the Parser slow?")]);
    stored(root, "other", 10);

    const withText = await searchSessions(discovery(root), "parser");
    const titlesOnly = await searchSessions(discovery(root, false), "parser");

    expect(withText.map((s) => s.id)).toEqual([content.getId(), titled.getId()]);
    expect(titlesOnly.map((s) => s.id)).toEqual([titled.getId()]);
  });
});

describe("findMostRecent", () => {
  it("returns the most recently modified session's path, or null", async () => {
    const root = useTempDir();
    expect(await findMostRecent(discovery(root))).toBeNull();

    stored(root, "a", 0);
    const latest = stored(root, "b", 5);

    expect(await findMostRecent(discovery(root))).toBe(latest.getSessionFile());
  });
});

describe("deleteSession", () => {
  it("removes the matching file; forks keep working", async () => {
    const root = useTempDir();
    const parent = stored(root, "parent", 0);
    const fork = parent.fork();

    expect(await deleteSession(discovery(root), parent.getId())).toBe(true);

    expect(existsSync(parent.getSessionFile() as string)).toBe(false);
    expect(SessionManager.open(fork.getSessionFile() as string).getEntries()).toHaveLength(2);
  });

  it("returns false for unknown IDs and never builds a path from the ID", async () => {
    const root = useTempDir();
    stored(root, "a", 0);
    const outside = join(root, "proj", "victim.jsonl");
    writeFileSync(outside, "keep me");

    expect(await deleteSession(discovery(root), "missing")).toBe(false);
    expect(await deleteSession(discovery(root), "../victim")).toBe(false);
    expect(await deleteSession(discovery(useTempDir()), "a-1")).toBe(false); // no directory
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(sessionsDir(root, "proj"))).toHaveLength(1);
  });

  it("matches IDs exactly, even when one ID ends with another", async () => {
    const root = useTempDir();
    const dir = sessionsDir(root, "proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-10-31T00-00-00-000Z_x_y.jsonl"), "");

    expect(sessionIdFromFileName("2026-10-31T00-00-00-000Z_x_y.jsonl")).toBe("x_y");
    expect(await deleteSession(discovery(root), "y")).toBe(false);
    expect(await deleteSession(discovery(root), "x_y")).toBe(true);
  });
});

describe("renameSession", () => {
  it("appends a title entry that listing picks up", async () => {
    const root = useTempDir();
    const session = stored(root, "s", 0, undefined, { title: "Old" });
    const file = session.getSessionFile() as string;

    renameSession(file, "New");

    expect(readJsonl(file).at(-1)).toMatchObject({ type: "title", title: "New" });
    expect((await listSessions(discovery(root)))[0].title).toBe("New");
  });
});
