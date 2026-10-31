import { SessionError } from "./types.js";

export const CURRENT_SESSION_VERSION = 1;

export interface Migration {
  /** Upgrades files at `fromVersion` to `fromVersion + 1`. */
  fromVersion: number;
  description: string;
  /** Receives line 1 (the header) followed by the entries; returns the upgraded lines. */
  migrate: (lines: unknown[]) => unknown[];
}

/** Engine-owned upgrade steps; empty at version 1. */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrateOptions {
  /** Default: `MIGRATIONS`. */
  migrations?: readonly Migration[];
  /** Default: `CURRENT_SESSION_VERSION`. */
  currentVersion?: number;
}

/**
 * Brings a parsed session file (header first) up to the current schema version, one step at a
 * time. The runner sets `header.version` after each step; migrations do not.
 */
export function migrateSession(
  lines: unknown[],
  options: MigrateOptions = {},
): { lines: unknown[]; migrated: boolean } {
  const migrations = options.migrations ?? MIGRATIONS;
  const currentVersion = options.currentVersion ?? CURRENT_SESSION_VERSION;

  const fileVersion = (lines[0] as { version?: unknown }).version;
  if (typeof fileVersion !== "number" || !Number.isInteger(fileVersion) || fileVersion < 1) {
    throw new SessionError(
      "invalid_header",
      `Invalid session version: ${JSON.stringify(fileVersion)}`,
    );
  }
  let version = fileVersion;
  if (version > currentVersion) {
    throw new SessionError(
      "unsupported_version",
      `Session version ${version} is newer than the supported version ${currentVersion}`,
    );
  }

  let migrated = false;
  while (version < currentVersion) {
    const from = version;
    const step = migrations.find((m) => m.fromVersion === from);
    if (!step) throw new SessionError("missing_migration", `No migration from version ${from}`);
    lines = step.migrate(lines);
    version = from + 1;
    (lines[0] as { version: number }).version = version;
    migrated = true;
  }
  return { lines, migrated };
}
