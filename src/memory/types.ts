export const DEFAULT_MEMORY_FILE_NAME = "MEMORY.md";
export const DEFAULT_MAX_CONTEXT_LINES = 200;
export const DEFAULT_MAX_CONTEXT_CHARS = 25_000;

export interface MemoryConfig {
  /** Root directory for agent storage. */
  storageRoot: string;
  /** A single path segment (see `projectIdFromCwd`). */
  projectId: string;
  /** A plain file name. Default: "MEMORY.md". */
  fileName?: string;
  /** Lines loaded into the prompt by `readMemory`. Default: 200. */
  maxContextLines?: number;
  /** Characters loaded into the prompt by `readMemory`. Default: 25,000. */
  maxContextChars?: number;
}

export interface ReadMemoryOptions {
  /** Maximum lines to read from the top of the file. */
  maxLines?: number;
  /** Maximum characters to return, excluding the truncation footer. */
  maxChars?: number;
}

/** Used verbatim as the `## <category>` heading. */
export type MemoryCategory =
  | "Conventions"
  | "Architecture"
  | "Preferences"
  | "Environment"
  | (string & {});
