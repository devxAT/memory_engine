import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMessageEntry, type SessionEntry } from "../compaction/types.js";
import { SessionManager } from "./manager.js";
import { migrateSession } from "./migrations.js";
import { sessionIdFromFileName, sessionsDir } from "./paths.js";
import { parseLines } from "./store.js";
import {
  effectiveTitle,
  type SessionDiscoveryConfig,
  SessionError,
  type SessionHeader,
  type SessionSummary,
} from "./types.js";

const PREVIEW_CHARS = 150;

interface LoadedSession<TMsg> {
  file: string;
  header: SessionHeader;
  entries: SessionEntry<TMsg>[];
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** File names in the sessions directory; empty when it does not exist. */
async function sessionFileNames(config: SessionDiscoveryConfig<unknown>): Promise<string[]> {
  try {
    return await readdir(sessionsDir(config.storageRoot, config.projectId));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** Parsed and migrated in memory; undefined for invalid files and files deleted meanwhile. */
async function loadSession<TMsg>(file: string): Promise<LoadedSession<TMsg> | undefined> {
  try {
    const { lines } = migrateSession(parseLines(await readFile(file, "utf8"), file).lines);
    return {
      file,
      header: lines[0] as SessionHeader,
      entries: lines.slice(1) as SessionEntry<TMsg>[],
    };
  } catch (err) {
    if (err instanceof SessionError || isMissing(err)) return undefined;
    throw err;
  }
}

/** Every valid session, read one file at a time. */
async function loadSessions<TMsg>(
  config: SessionDiscoveryConfig<TMsg>,
): Promise<LoadedSession<TMsg>[]> {
  const dir = sessionsDir(config.storageRoot, config.projectId);
  const sessions: LoadedSession<TMsg>[] = [];
  for (const name of await sessionFileNames(config)) {
    if (!name.endsWith(".jsonl")) continue;
    const session = await loadSession<TMsg>(join(dir, name));
    if (session) sessions.push(session);
  }
  return sessions;
}

function summarize<TMsg>(
  { file, header, entries }: LoadedSession<TMsg>,
  accessor: SessionDiscoveryConfig<TMsg>["accessor"],
): SessionSummary {
  let messageCount = 0;
  let preview: string | null = null;
  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;
    messageCount++;
    if (preview === null && accessor?.getOrigin(entry.message) === "human") {
      const text = accessor.toText(entry.message).replace(/\s+/g, " ").trim();
      if (text !== "") preview = text.slice(0, PREVIEW_CHARS);
    }
  }
  return {
    id: header.id,
    path: file,
    title: effectiveTitle(header, entries) ?? null,
    cwd: header.cwd,
    created: new Date(header.timestamp),
    modified: new Date(entries.at(-1)?.timestamp ?? header.timestamp),
    messageCount,
    preview,
    parentSessionId: header.parentSessionId,
  };
}

/** Most recently modified first; ties broken by file name, which starts with the creation time. */
const byModifiedDesc = (a: SessionSummary, b: SessionSummary) =>
  b.modified.getTime() - a.modified.getTime() || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0);

/**
 * Summaries of every valid session in the project, most recently modified first. Reads each file
 * in full; files without a valid header are skipped, and migrations run in memory only.
 */
export async function listSessions<TMsg = unknown>(
  config: SessionDiscoveryConfig<TMsg>,
): Promise<SessionSummary[]> {
  const sessions = await loadSessions(config);
  return sessions.map((s) => summarize(s, config.accessor)).sort(byModifiedDesc);
}

/**
 * Sessions whose title or, with an accessor, any message text contains `query`
 * (case-insensitive), in `listSessions` order.
 */
export async function searchSessions<TMsg = unknown>(
  config: SessionDiscoveryConfig<TMsg>,
  query: string,
): Promise<SessionSummary[]> {
  const needle = query.toLowerCase();
  const { accessor } = config;
  const matches = (session: LoadedSession<TMsg>) =>
    effectiveTitle(session.header, session.entries)?.toLowerCase().includes(needle) ||
    (accessor !== undefined &&
      session.entries.some(
        (entry) =>
          isMessageEntry(entry) && accessor.toText(entry.message).toLowerCase().includes(needle),
      ));

  const sessions = await loadSessions(config);
  return sessions
    .filter(matches)
    .map((s) => summarize(s, accessor))
    .sort(byModifiedDesc);
}

/** Path of the most recently modified session, for `--continue`. */
export async function findMostRecent(
  config: SessionDiscoveryConfig<unknown>,
): Promise<string | null> {
  const [latest] = await listSessions(config);
  return latest?.path ?? null;
}

/**
 * Deletes the session's file. The ID is matched against the directory listing; a path is never
 * built from it. Returns false when no file matches. Forks of the session keep working.
 */
export async function deleteSession(
  config: SessionDiscoveryConfig<unknown>,
  sessionId: string,
): Promise<boolean> {
  const name = (await sessionFileNames(config)).find((n) => sessionIdFromFileName(n) === sessionId);
  if (name === undefined) return false;
  await rm(join(sessionsDir(config.storageRoot, config.projectId), name), { force: true });
  return true;
}

/**
 * Appends a title entry to a stored session. Do not use it on a session another manager has
 * open: there is one writer per file.
 */
export function renameSession(file: string, title: string): void {
  SessionManager.open(file).setTitle(title);
}
