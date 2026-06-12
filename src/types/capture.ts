// Wire type for Process Capture events crossing the Rust -> JS boundary.
//
// Mirror of the Rust `CaptureEvent` struct in
// `src-tauri/src/platform/process_watch.rs`, which serialises with
// `#[serde(rename_all = "camelCase")]`. Keep the two in lockstep — the
// only field whose name changes across the boundary is
// `command_line` -> `commandLine`. See `docs/process-capture.md`.

/**
 * One captured process birth forwarded from the Rust ETW watcher on the
 * `capture-event` channel.
 *
 * `commandLine` is the RAW value from the OS and MAY contain secrets
 * (passwords, tokens). Always run it through `redactSecrets` before showing
 * it or persisting anything derived from it.
 */
export interface CaptureEvent {
  /** PID of the newly-started process. */
  pid: number;
  /** PID of the parent (the process that spawned it). */
  ppid: number;
  /** Full path to the executable image. */
  image: string;
  /** The process's command line, exactly as reported by the OS. */
  commandLine: string;
  /** Event time as an ISO-8601 (UTC) string. */
  timestamp: string;
}

/**
 * A process the user can pick as the capture-scope root in the Recorder
 * ("record this app and its children"). Mirror of the Rust `CaptureTarget`
 * struct (camelCase serde). Returned by the `list_capture_targets` command.
 */
export interface CaptureTarget {
  /** PID to use as the `Subtree` scope root. */
  pid: number;
  /** Human-readable process name (`/proc/<pid>/comm` on Linux). */
  name: string;
}

/**
 * What slice of the process-birth stream to capture. Mirror of the Rust
 * `CaptureScope` enum, serialised as an internally-tagged union
 * (`{ mode, roots }`). Passed to `start_process_capture`.
 *
 * - `all` — capture everything (the previous default).
 * - `subtree` — only the given root PIDs and their descendants (the base
 *   "record this app" scenario).
 * - `excludeSubtree` — everything except the given subtree (reserved for
 *   subtracting ProcMix's own / launcher tree).
 */
export type CaptureScope =
  | { mode: "all" }
  | { mode: "subtree"; roots: number[] }
  | { mode: "excludeSubtree"; roots: number[] };
