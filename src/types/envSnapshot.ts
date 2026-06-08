/**
 * Types mirroring `core::env_sources` structs from the Rust backend.
 * All names are camelCase (serde's `rename_all = "camelCase"` on the Rust side).
 */

/**
 * A single environment variable with the list of known files that contain
 * an assignment for its key. `sources` is empty when no known file mentions
 * the key — the UI renders this as "source unknown".
 */
export interface EnvVarWithSources {
  key: string;
  value: string;
  /**
   * Absolute paths of known shell-startup files that contain a `KEY=` or
   * `export KEY=` line for this variable, in load order. Multiple entries
   * are normal (e.g. PATH is typically touched by /etc/environment AND
   * ~/.profile AND ~/.bashrc).
   */
  sources: string[];
}

/**
 * Status of one known shell-startup file that was inspected for variable
 * assignments. Unreadable files are reported here (not silently dropped)
 * so the UI can explain "source could not be determined" with context.
 */
export interface EnvFileStatus {
  path: string;
  /** True when the file existed and was read successfully. */
  readable: boolean;
  /**
   * Human-readable error string when `readable` is false and the failure
   * was NOT simply "file does not exist" (which is silenced).
   * English-only — comes from the OS/libc layer.
   */
  error?: string;
  /** Variable names assigned in this file (deduplicated, sorted). */
  keys: string[];
}

/**
 * Complete environment snapshot for one scope (user or root).
 * Returned by `get_user_env_with_sources` / `get_root_env_with_sources`.
 */
export interface EnvSnapshot {
  /** All variables, sorted alphabetically by key. */
  vars: EnvVarWithSources[];
  /**
   * Status of every known file that was inspected.
   * Lets the UI show "this file was unreadable" per-file.
   */
  files: EnvFileStatus[];
}
