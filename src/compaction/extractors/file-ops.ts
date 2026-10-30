import type { ToolCallInfo } from "../types.js";
import type { ExtractorPlugin, ToolObservation } from "./types.js";

export interface FileOpsConfig {
  readTools: string[];
  writeTools: string[];
  editTools: string[];
  /** Checked in order; the first string value is the path. */
  pathArgKeys: string[];
  normalizePath: (path: string) => string;
  /** Per list; the oldest entries are dropped first. */
  maxFilesPerList: number;
}

export const DEFAULT_FILE_OPS_CONFIG: FileOpsConfig = {
  readTools: ["read", "read_file", "view"],
  writeTools: ["write", "write_file", "create"],
  editTools: ["edit", "str_replace_editor", "patch"],
  pathArgKeys: ["path", "file_path", "filePath", "file"],
  normalizePath: (p) => p.replace(/\\/g, "/").replace(/^\.\//, ""),
  maxFilesPerList: 200,
};

export interface FileOpsDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface FileOpsState {
  /** Insertion-ordered: oldest first. */
  read: Set<string>;
  modified: Set<string>;
}

/**
 * Tracks files read and modified through file tools. Files changed through shell commands
 * (`sed -i`, `git checkout`, `rm`) are not captured.
 */
export class FileOpsExtractor implements ExtractorPlugin<FileOpsState> {
  readonly name = "file_operations";
  private readonly config: FileOpsConfig;

  constructor(config: Partial<FileOpsConfig> = {}) {
    this.config = { ...DEFAULT_FILE_OPS_CONFIG, ...config };
  }

  createState(): FileOpsState {
    return { read: new Set(), modified: new Set() };
  }

  mergePrevious(previous: unknown, state: FileOpsState): void {
    const prev = readDetails(previous);
    for (const f of prev.readFiles) touch(state.read, f);
    for (const f of prev.modifiedFiles) touch(state.modified, f);
  }

  observe({ call, result }: ToolObservation, state: FileOpsState): void {
    if (!result || result.isError) return; // unknown or failed outcome: not tracked
    const op = this.classify(call);
    if (!op) return;
    touch(op.kind === "read" ? state.read : state.modified, op.path);
  }

  serialize(state: FileOpsState): FileOpsDetails {
    const cap = this.config.maxFilesPerList;
    return {
      readFiles: [...state.read].slice(-cap),
      modifiedFiles: [...state.modified].slice(-cap),
    };
  }

  render(details: unknown): string {
    const { readFiles, modifiedFiles } = readDetails(details);
    const modified = new Set(modifiedFiles);
    const readOnly = readFiles.filter((f) => !modified.has(f)).sort();
    const sections: string[] = [];
    if (readOnly.length > 0) {
      sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
    }
    if (modified.size > 0) {
      sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
    }
    return sections.join("\n\n");
  }

  /** Public so micro-compaction can detect superseded reads. */
  classify(call: ToolCallInfo): { kind: "read" | "modify"; path: string } | undefined {
    const path = this.extractPath(call.arguments);
    if (!path) return undefined;
    if (this.config.readTools.includes(call.name)) return { kind: "read", path };
    if (this.config.writeTools.includes(call.name) || this.config.editTools.includes(call.name)) {
      return { kind: "modify", path };
    }
    return undefined;
  }

  private extractPath(args: Record<string, unknown> | undefined): string | undefined {
    if (!args) return undefined;
    for (const key of this.config.pathArgKeys) {
      const value = args[key];
      if (typeof value === "string") return this.config.normalizePath(value);
    }
    return undefined;
  }
}

/** Adds or moves `value` to the newest position. */
function touch(set: Set<string>, value: string): void {
  set.delete(value);
  set.add(value);
}

/** Stored details come back from JSON; anything malformed reads as empty lists. */
function readDetails(value: unknown): FileOpsDetails {
  const d = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { readFiles: stringList(d.readFiles), modifiedFiles: stringList(d.modifiedFiles) };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
