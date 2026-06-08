export type EnvSource = 'system' | 'file';

/** A single environment variable entry, annotated with its source. */
export interface EnvEntry {
  key: string;
  value: string;
  /** Where the value came from. */
  source: EnvSource;
  /** Absolute path to the .env file (only set when `source === 'file'`). */
  filePath?: string;
  /** 1-based line number inside the file (only set when `source === 'file'`). */
  line?: number;
}

/**
 * The parsed content of a single .env file.
 *
 * `error` is set when the file could not be read; `entries` is empty in that
 * case. The frontend shows the error inline rather than propagating it as an
 * exception.
 */
export interface EnvFileSummary {
  path: string;
  entries: EnvEntry[];
  error?: string;
}

/**
 * The shape of `EnvFileSummary` as returned by the Rust IPC layer before
 * we annotate each entry with `source` / `filePath`.
 *
 * Mirrors `core::env_files::EnvFileSummary` (camelCase) exactly.
 */
export interface RawEnvFileSummary {
  path: string;
  entries: Array<{ key: string; value: string; line: number }>;
  error: string | null;
}
