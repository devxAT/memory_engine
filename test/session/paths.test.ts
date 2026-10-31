import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathSegment,
  projectDir,
  projectIdFromCwd,
  sessionFileName,
  sessionsDir,
} from "../../src/session/paths.js";

const invalidProjectId = expect.objectContaining({ code: "invalid_project_id" });

describe("isPathSegment", () => {
  it("accepts plain names and rejects empty, dot names, and separators", () => {
    expect(["proj", "C--dev-app", "a.b", ".hidden"].map(isPathSegment)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["", ".", "..", "a/b", "a\\b", "../x"].map(isPathSegment)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("projectIdFromCwd", () => {
  it("replaces every non-alphanumeric character with a dash, on any platform", () => {
    expect(projectIdFromCwd("C:\\dev\\my_app")).toBe("C--dev-my-app");
    expect(projectIdFromCwd("/home/me/my.app")).toBe("-home-me-my-app");
  });

  it("cuts long slugs and adds a hash of the full path", () => {
    const deep = (leaf: string) => `/${"a".repeat(250)}/${leaf}`;
    const one = projectIdFromCwd(deep("one"));
    const two = projectIdFromCwd(deep("two"));

    expect(one).toMatch(/^-a{199}-[0-9a-f]{8}$/);
    expect(one).toHaveLength(209);
    expect(one).not.toBe(two); // same first 200 characters
    expect(projectIdFromCwd(deep("one"))).toBe(one);
  });
});

describe("projectDir / sessionsDir", () => {
  it("place sessions under <storageRoot>/<projectId>/sessions", () => {
    expect(projectDir("/root", "proj")).toBe(join("/root", "proj"));
    expect(sessionsDir("/root", "proj")).toBe(join("/root", "proj", "sessions"));
  });

  it("reject a projectId that is not a single path segment", () => {
    for (const id of ["", "..", "../escape", "a/b", "a\\b"]) {
      expect(() => projectDir("/root", id)).toThrow(invalidProjectId);
      expect(() => sessionsDir("/root", id)).toThrow(invalidProjectId);
    }
  });
});

describe("sessionFileName", () => {
  it("is <timestamp>_<id>.jsonl with Windows-safe timestamps", () => {
    expect(sessionFileName({ id: "abc", timestamp: "2026-10-31T20:45:12.345Z" })).toBe(
      "2026-10-31T20-45-12-345Z_abc.jsonl",
    );
  });
});
