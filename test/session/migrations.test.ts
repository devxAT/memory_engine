import { describe, expect, it } from "vitest";
import {
  CURRENT_SESSION_VERSION,
  MIGRATIONS,
  type Migration,
  migrateSession,
} from "../../src/session/migrations.js";

const file = (version: unknown, ...entries: unknown[]) => [
  { type: "session", version, id: "s1" },
  ...entries,
];
const code = (c: string) => expect.objectContaining({ code: c });

/** v1 → v2 renames `text` to `body`; v2 → v3 adds `tags`. */
const renameText: Migration = {
  fromVersion: 1,
  description: "rename text to body",
  migrate: (lines) =>
    lines.map((line, i) => {
      if (i === 0) return line;
      const { text, ...rest } = line as { text: string };
      return { ...rest, body: text };
    }),
};
const addTags: Migration = {
  fromVersion: 2,
  description: "add tags",
  migrate: (lines) => lines.map((line, i) => (i === 0 ? line : { ...(line as object), tags: [] })),
};

describe("migrateSession", () => {
  it("starts at version 1 with no built-in migrations", () => {
    expect(CURRENT_SESSION_VERSION).toBe(1);
    expect(MIGRATIONS).toEqual([]);
  });

  it("returns current files unchanged", () => {
    const lines = file(1, { text: "a" });
    expect(migrateSession(lines)).toEqual({ lines, migrated: false });
  });

  it("applies every step in version order, whatever the registration order", () => {
    const result = migrateSession(file(1, { text: "a" }), {
      migrations: [addTags, renameText],
      currentVersion: 3,
    });

    expect(result).toEqual({
      lines: [
        { type: "session", version: 3, id: "s1" },
        { body: "a", tags: [] },
      ],
      migrated: true,
    });
  });

  it("sets the header version itself after each step", () => {
    const seen: unknown[] = [];
    const spy = (fromVersion: number): Migration => ({
      fromVersion,
      description: "",
      migrate: (lines) => {
        seen.push((lines[0] as { version: number }).version);
        return lines;
      },
    });

    migrateSession(file(1), { migrations: [spy(1), spy(2)], currentVersion: 3 });

    expect(seen).toEqual([1, 2]);
  });

  it("throws missing_migration when a step is missing", () => {
    expect(() => migrateSession(file(1), { migrations: [addTags], currentVersion: 3 })).toThrow(
      code("missing_migration"),
    );
  });

  it("refuses files written by a newer engine", () => {
    expect(() => migrateSession(file(2))).toThrow(code("unsupported_version"));
  });

  it("throws invalid_header for a missing or invalid version", () => {
    for (const version of [undefined, 0, -1, 1.5, "1"]) {
      expect(() => migrateSession(file(version))).toThrow(code("invalid_header"));
    }
  });
});
