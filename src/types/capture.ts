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
