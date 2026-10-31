# Session & Memory Docs: Changes After First Review

**Date**: 2026-10-31

This file records what changed in the session and memory docs after the first design review, and why. The main docs are already updated; this is the summary of the differences.

Files changed:
- [architecture/session.md](../architecture/session.md) (most changes; section numbers below refer to the new version)
- [architecture/memory.md](../architecture/memory.md)
- [docs/session.md](session.md)
- [AGENT.md](../AGENT.md)
- [architecture/compaction.md](../architecture/compaction.md), [docs/compaction.md](compaction.md), `src/compaction/types.ts` (cross-references and phase numbering only)
- `package.json` (description)

---

## Summary

| # | Change | Type |
| :--- | :--- | :--- |
| 1 | One storage layout for sessions and memory; `projectId` validated | Bug fix |
| 2 | Linear timeline made precise: file order is the path | Design |
| 3 | Forks copy entries verbatim and flush the parent first | Bug fix |
| 4 | Flush trigger uses the host's accessor; flush and append failure rules | Bug fix |
| 5 | Torn and malformed lines handled on read | Gap |
| 6 | Titles appended as entries instead of rewriting line 1 | Design |
| 7 | Migration runner: built-in, strict sequence, newer files refused, rewrite after migrating | Bug fix |
| 8 | Host message format recorded in the header, with an upgrade hook | Gap |
| 9 | `TitleEntry` and `CustomEntry` defined; other entry types reserved | Gap |
| 10 | Manager API: `create`/`open`, synchronous, `appendEntry` typing, test hooks | Design |
| 11 | Discovery: full scan, accessor for previews and search, safe delete | Bug fix |
| 12 | `SessionError` with codes | Gap |
| 13 | Single-writer assumption stated | Gap |
| 14 | Memory: one category list, `appendNote` algorithm, atomic writes, truncation rules | Bug fix |
| 15 | Research doc corrections | Docs |
| 16 | Cross-doc consistency (AGENT.md, compaction spec, phase numbering) | Docs |

---

## 1. One Storage Layout

**What changed**:
- Sessions live in `<storageRoot>/<projectId>/sessions/`, and `MEMORY.md` in `<storageRoot>/<projectId>/`. A new `paths.ts` builds both paths.
- `projectId` must be a single path segment. `projectIdFromCwd(cwd)` derives a Claude-style slug for hosts that don't have their own ID; long slugs are cut and given a hash suffix.
- File names use the header timestamp with `:` and `.` replaced by `-`.

**Why**: The session spec scanned `<storageRoot>/<projectId>/` for session files, while the memory spec put them in `<projectId>/sessions/`. Nothing said who sanitizes `projectId`; a raw path or `..` would write outside the storage root.

**Where**: session §2.1; memory §2.

## 2. Linear Timeline Made Precise

**What changed**: File order is the conversation path. Each entry's `parentId` is the previous entry's `id`. `getEntries()` is passed straight to `CompactionEngine`. Rewinding to an earlier message is a fork.

**Why**: The spec adopted one timeline per file but kept `parentId` without saying what it means. AGENT.md still advertised "tree-structured JSONL persistence preserving full conversation graphs". The old Phase 2 roadmap item that produced the compaction `path` (leaf → root resolution) was dropped without a replacement.

**Where**: session §1 (rules 2 and 4), §8; docs §3.1; AGENT.md.

## 3. Forking

**What changed**:
- Copied entries keep their `id`, `parentId`, and `timestamp`.
- A persisted parent that hasn't flushed yet is flushed before the fork.
- The child is written immediately. It inherits `cwd`, `messageFormat`, `title`, and `metadata` (options override); `ForkOptions.title` is appended as a title entry.
- An unknown fork target throws `entry_not_found`.
- New guidance on choosing a fork point: the manager can't detect a dangling tool call.

**Why**:
- Compaction entries point at earlier entries through `firstKeptEntryId`. If a fork generated new IDs, building the context of a forked, compacted session would throw `missing_kept_entry`. `forkedFromEntryId` also has to name an entry that exists in the child.
- Forking an unflushed session would leave `parentSessionId` pointing at a file that doesn't exist.
- The old spec didn't say whether forks follow the delayed flush.

**Where**: session §5.

## 4. Delayed Flush

**What changed**:
- Trigger: appending a message whose origin is `model`, read through the optional `config.accessor.getOrigin`, or calling `flush()`. The `isCompletion` parameter of `appendMessage` is removed.
- The flush uses `writeFileSync(…, { flag: "wx" })` and no longer claims to be atomic.
- A failed flush leaves the session UNFLUSHED; the next append or `flush()` retries.
- After the flush, each entry is written to disk before it is added to memory.
- The file path is fixed at creation; `isFlushed()` was added.

**Why**:
- "Or `msg` is an assistant message" requires reading the message, which the manager can't do: it is generic over `TMsg` and has no accessor. Two triggers for one event (a flag and message inspection) was ambiguous.
- `writeFileSync` is not atomic. `wx` also stops a flush from overwriting an existing file.
- Writing before committing keeps memory and disk in agreement when a write throws.

**Where**: session §4.3, §7.

## 5. Reading Damaged Files

**What changed**: A malformed last line is dropped as a torn write, and the file is truncated to the last valid line before the next append. A malformed line elsewhere throws `malformed_line` with its line number. A missing header throws `invalid_header`. The headerless "legacy v0" format is removed.

**Why**: The spec promised crash resilience but parsed "all non-empty JSON lines", so one torn line from a crash would make a session unloadable. Appending after a torn line without truncating would glue the next entry onto it and corrupt a second line. No headerless files exist: this engine has never written one.

**Where**: session §2.4.

## 6. Titles as Entries

**What changed**: `setTitle` appends a `TitleEntry`. The effective title is the last title entry, or else the header's `title`. `renameSession` is shorthand for `open(file).setTitle(title)`.

**Why**: Changing line 1 means rewriting the whole file. That breaks the append-only rule and races with a live session appending to the same file: entries appended between the read and the rewrite are lost. Claude Code (`custom-title`) and Pi (`session_info`) also append renames as records.

**Trade-off**: listing has to read past line 1 to find the current title (see #11).

**Where**: session §2.3, §6.1, §7.

## 7. Migration Runner

**What changed**:
- A built-in `MIGRATIONS` constant and a pure `migrateSession(lines, migrations)` function replace the public `MigrationRegistry` class.
- Each migration goes from `fromVersion` to `fromVersion + 1`. `toVersion` is removed, and the runner sets `header.version`.
- A missing step throws `missing_migration`. A file newer than `CURRENT_SESSION_VERSION` throws `unsupported_version`.
- A migrated file is rewritten (temp file + rename) before the first append. Discovery migrates in memory only.

**Why**:
- The registry made one pass in registration order, so steps registered out of order were skipped, and a gap left the file at an old version without an error.
- A file from a newer engine was returned unchanged and would have had old-format entries appended to it.
- "Can be optionally rewritten" was a bug: current-format entries appended under an old header would be migrated a second time on the next load. Pi always rewrites a migrated file.
- Only the engine knows its own schema, so hosts have nothing to register. A function with injectable migrations is easier to test and follows the "pure functions over classes" convention.

**Where**: session §3.1, §3.3.

## 8. Host Message Format

**What changed**: The header gains `messageFormat`. On open, `OpenOptions.messageFormat` and `upgradeMessage` upgrade old messages; a mismatch without `upgradeMessage` throws `message_format_mismatch`.

**Why**: The compaction spec (§2.2) and [compaction-changes #1](compaction-changes.md) left this header field to the session spec, which then didn't include it. Without it, a host whose message type changes cannot detect or upgrade old sessions.

**Where**: session §2.2, §3.2. Compaction §2.2 now links there.

## 9. Entry Types

**What changed**: `TitleEntry` and `CustomEntry` (`type: "custom"`, `customType`, `data`) are defined. Every type other than `message`, `prune`, `compaction`, `title`, and `custom` is reserved for the engine. `appendEntry` rejects `session`, `message`, and `title`.

**Why**: `CustomEntry` was listed but never defined. A single namespaced `custom` type keeps host events from colliding with future engine types. Rejecting `message` in `appendEntry` stops a host from bypassing the flush trigger by accident.

**Where**: session §2.3, §7.

## 10. Manager API

**What changed**:
- `SessionManager.create(config)` and `SessionManager.open(file, options)` replace the constructor with an optional `sessionFile`.
- All manager methods are synchronous; `setTitle` and `fork` previously returned promises.
- Added `getHeader()` and `isFlushed()`. `setTitle` returns its entry. `getEntries()` excludes the header and returns a shallow copy.
- `appendEntry<E extends { type: string }>(entry: E): E & SessionEntryBase`.
- `generateId` and `now` are injectable.
- `SessionConfig` is generic (for the accessor) and gains `messageFormat` and `accessor`.
- No per-module `index.ts`.

**Why**:
- A constructor cannot do async I/O, and resuming ignores `cwd`, `title`, and `metadata`, which the old config required anyway.
- Appends were already synchronous (`appendFileSync`). Async `setTitle` and `fork` running alongside them could interleave writes.
- The old `appendEntry<E>(entry: NewEntry<E>): E` infers `E` only when the argument is already typed `NewEntry<X>` (engine output). For an object literal, such as a custom entry, it returned `SessionEntryBase`.
- Tests must be deterministic (AGENT.md), so random IDs and the clock need to be injectable.
- The repo re-exports each file from `src/index.ts`; compaction has no `index.ts`.

**Where**: session §1, §4.1, §7.

## 11. Discovery

**What changed**:
- `listSessions` reads each file in full instead of lines 1 and 2, skips files without a valid header, and sorts by the last entry's timestamp rather than file mtime.
- `entryCount` became `messageCount`; `cwd` was added.
- `preview` is the first human message's text. It needs an optional accessor (`getOrigin`, `toText`) in `SessionDiscoveryConfig`; without one, `preview` is `null` and search matches titles only.
- `deleteSession` matches the ID against the directory listing and never builds a path from it.
- `renameSession` is synchronous.
- A missing directory gives empty results, not errors.

**Why**:
- `entryCount` and appended titles can't come from lines 1 and 2. Line 2 isn't necessarily the first user message (harness messages and custom entries come first sometimes), and the engine can't recognize a user message or extract its text without the accessor.
- File mtime changes when files are copied or synced.
- A path built from an unchecked ID could delete files outside the sessions directory.

**Trade-off**: listing cost grows with total transcript size, as in Pi, which also reads every file. Search reads every transcript anyway. A catalog (Codex keeps one in SQLite) is listed as an open point.

**Where**: session §6; AGENT.md open points.

## 12. Errors

**What changed**: `SessionError` with a `code` (`invalid_project_id`, `invalid_header`, `malformed_line`, `unsupported_version`, `missing_migration`, `message_format_mismatch`, `entry_not_found`, `invalid_entry`), shaped like `CompactionError`.

**Why**: `InvalidSessionFileError` was referenced but never defined, and the other failure modes had no error at all.

**Where**: session §9.

## 13. Single Writer

**What changed**: Stated as a design rule for sessions and memory.

**Why**: Two managers on one file (for example two terminals running `--continue`) interleave entries and break the linear timeline. Read-modify-write of `MEMORY.md` from two processes loses notes. Locking is listed as an open point.

**Where**: session §1 rule 6; memory §1 rule 6; docs §3.7; AGENT.md open points.

## 14. Memory

**What changed**:
- One category list (`Conventions`, `Architecture`, `Preferences`, `Environment`), used verbatim as headings in the design rules, the type, and the example file.
- `appendNote` is specified: heading match, where a section ends, insertion point, duplicates, multi-line notes, missing file or heading.
- All writes are atomic (temp file + rename).
- Truncation applies the line limit, then drops whole lines to fit the character limit. The footer states how many lines were left out and the file path, and doesn't count toward the budget.
- Removed `ReadMemoryOptions.silent` (`readMemory` always returns `null` for a missing file) and the unused `MemoryNote`.
- `clear()` deletes the file.
- Rule 2 is renamed "Context Budgeting" (truncation is not progressive disclosure). New rule: the engine stores memory; the host decides what to remember.
- Memory text counts toward `ModelBudget.overheadTokens`.

**Why**:
- The three lists disagreed (`Conventions & Rules` vs `Conventions`, `User Preferences` vs `Preferences`, `Build & Test` vs `Environment`), so `appendNote("Conventions", …)` would add a second section instead of finding the existing one.
- A crash during a plain overwrite truncates a file the developer curates by hand.
- Cutting at a character count could split a line mid-word, and the agent can only fetch the rest if the footer says where it is.
- `silent: false` added a throwing mode with no use case; the API never took a `MemoryNote`.

**Where**: memory.md throughout.

## 15. Research Doc Corrections

The claims about Claude Code, Codex, and Pi were checked against primary sources: the Pi and Codex source code, and the Claude Code docs plus the open-source Claude Agent SDK, which reads and writes the same transcript files (the CLI is closed source).

**What changed**:
- **Claude Code**:
  - Records carry `parentUuid`, so one file can hold several branches. Its transcripts are not strictly one timeline per file, and §3.1 no longer implies they are.
  - `/fork` copies the conversation into a background session; the command that forks and switches is `/branch`. The Agent SDK's fork assigns new IDs, while this design keeps them (#3).
  - Renames append a `custom-title` record.
  - `MEMORY.md` is an index pointing to topic files, not the note store. `CLAUDE.md` (written by the developer, loaded in full) is now distinguished from auto memory.
  - The "dream" pass appears only in prompts extracted from the CLI, so it is now marked unconfirmed.
- **Codex**: `RetainedContext` is restored on resume, not on "reconnects", and its caps are now stated. The memory system is off by default, and its location (`~/.codex/memories/`) is now given.
- **Pi**:
  - The delayed flush fires at the first user **or** assistant message, not the first assistant message.
  - Migrated files are rewritten. Renames append a `session_info` entry. Listing reads every file in full.
  - `/fork` and `/clone` create new files.
- A new "Branches Inside One File" observation replaces the Pi-only limitation, since Claude Code does the same.
- §3 notes where this design differs from the references: the flush trigger, kept fork IDs, and a single-file memory.

**Why**: The research doc is the justification for the spec. The original said the first-assistant-message flush and the single-timeline file were what Pi and Claude Code do, when both are actually choices this design makes.

**Supports other changes**: Claude Code and Pi both append renames instead of rewriting a header (#6), and Pi rewrites a file after migrating it (#7) and lists sessions by reading every file (#11).

**Where**: docs §2, §3.1, §3.2, §3.5.

## 16. Cross-Doc Consistency

**What changed**:
- AGENT.md: the capabilities and storage lines no longer say "tree-structured"; added a memory capability; the docs table lists this file; new open points (session catalog, concurrent writers, memory layout); the header/versioning point is marked resolved; the Phase 2 roadmap follows the new module list.
- architecture/compaction.md: "Phase 1b" became "Phase 3" (AGENT.md had renumbered it); §2.2 links to the session header spec; the §9 `path` comment and the §10 host loop use `SessionManager`.
- docs/compaction.md and the `topology` comment in `src/compaction/types.ts`: "Phase 1b" became "Phase 3".
- package.json description no longer says "tree-structured".

---

## Adjustments During Implementation

Small spec changes made while implementing Phase 2; the specs already include them.

| Change | Why |
| :--- | :--- |
| `projectIdFromCwd` uses the path as given instead of resolving it | `path.resolve` differs between Windows and POSIX, which would make the slug platform-dependent |
| `migrateSession(lines, { migrations, currentVersion })` instead of `migrateSession(lines, migrations)` | With `MIGRATIONS` empty at version 1, the runner could not be tested without an injectable target version |
| `isTitleEntry` / `isCustomEntry` take any `{ type: string }` | Interfaces are not assignable to the catch-all member of `SessionEntry`, so a `SessionEntry<TMsg>` guard does not compile |
| `deleteSession` parses the ID out of the file name (`sessionIdFromFileName`) instead of matching the suffix `_<id>.jsonl` | A suffix match lets ID `y` delete the file of ID `x_y` |
| `preview` is the first human message *that has text* | A first prompt that is only an image would otherwise give an empty preview |
| Memory: a blank `MEMORY.md` gets the default structure on `appendNote`; empty or multi-line categories throw | Treats blank like missing, as `readMemory` does; a line break in a category would break its heading |

---

## Still Open

- Judgment calls to confirm: titles as entries (which makes listing a full scan), a synchronous manager API, and forks inheriting the parent's title.
- Flush trigger: this spec keeps the original "first model message" rule. Pi flushes at the first user or assistant message, which keeps the first prompt if the process crashes during the first model call. Switching is a one-line change to §4.3.
- Session catalog, concurrent writers, memory layout, session compression, and reference accessors (AGENT.md open points).
