// IPC-boundary types and constants for the interactive Terminal feature.
//
// Deliberately separate from `core::executor::types` — see the module-level
// docs in `core::terminal::mod` and `docs/interactive-terminal.md` for why a
// raw PTY session is NOT a variant of the sandboxed script executor.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};

pub const TERMINAL_EVENT: &str = "terminal-event";

/// Hard cap on the number of simultaneous terminal sessions (across all
/// tabs). Bounds the number of live PTYs and reader threads a single
/// ProcMix instance will keep open. Reached only by a user deliberately
/// opening many tabs; enforced in `spawn_session` before a PTY is opened.
pub const MAX_TERMINAL_SESSIONS: usize = 10;

/// Event stream emitted for every terminal session, `tag = "type"` +
/// camelCase to match the `core::executor` event convention used for
/// `execution-event` (`ExecutionEvent`). Mirrors the TS `TerminalEvent`
/// union in `src/types/terminal.ts`.
///
/// NOTE: the container-level `#[serde(rename_all = "camelCase")]` below
/// converts ONLY the ENUM VARIANT names (redundant with the explicit
/// `#[serde(rename = "data")]`/`"exit"` on each variant) — it does NOT
/// rename the FIELDS of a struct-style variant. Each variant therefore
/// needs its OWN `#[serde(rename_all = "camelCase")]`, or fields like
/// `session_id` serialize verbatim as snake_case, silently breaking the
/// frontend's `event.sessionId` (undefined) — the exact bug that produced
/// a permanently blank/uninteractive terminal tab despite the backend
/// emitting events correctly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TerminalEvent {
    /// A chunk of raw PTY output (interleaved stdout/stderr — a PTY has no
    /// separate stderr stream once the child's fds are joined to the slave).
    /// Carries a base64-encoded byte chunk rather than a `String`: a fixed-
    /// size read can split a multi-byte UTF-8 sequence across two chunks, and
    /// decoding on the Rust side would then have to buffer/re-assemble the
    /// partial tail. Sending raw bytes (base64 for JSON transport) and
    /// decoding once in xterm.js — which already accepts a `Uint8Array` and
    /// assembles multi-byte sequences internally — avoids that class of bug
    /// entirely.
    #[serde(rename = "data", rename_all = "camelCase")]
    Data {
        session_id: String,
        /// Base64-encoded raw bytes read from the PTY master.
        data: String,
    },
    /// The child process exited (or the PTY reader hit EOF). No further
    /// `Data` events follow for this `session_id`.
    #[serde(rename = "exit", rename_all = "camelCase")]
    Exit {
        session_id: String,
        exit_code: Option<u32>,
    },
}

/// Per-session handle stored in [`TerminalState::sessions`].
///
/// `master` must be kept alive for the lifetime of the session — dropping it
/// closes the PTY out from under the child, and it is also the handle used
/// to `resize()`. `writer` is a boxed `Write` obtained from the master;
/// writes are short and run on a blocking thread per-call rather than
/// holding a dedicated task. `child` is kept so `close_session` /
/// `shutdown_all_sync` can kill the process tree.
pub struct TerminalSessionHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Box<dyn Child + Send + Sync>,
}

/// Registry of live terminal sessions, managed as Tauri app state exactly
/// like `core::executor::ExecutorState`. A `std::sync::Mutex` (not tokio's)
/// is used because every access is a short, synchronous map operation with
/// no `.await` held across the lock.
#[derive(Default)]
pub struct TerminalState {
    pub sessions: Mutex<HashMap<String, TerminalSessionHandle>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the "every terminal tab renders permanently
    /// blank, no keyboard input works" bug: `session_id` MUST serialize as
    /// `sessionId` — a bare container-level `rename_all` on the enum does
    /// NOT rename struct-variant fields, only variant names, so this needs
    /// an explicit `rename_all` on each variant (see the field's own doc
    /// comment). Asserting on the exact JSON string (not just round-trip)
    /// is deliberate — a round-trip test would pass even with the bug,
    /// because `Deserialize` uses the SAME (wrong) field name and would
    /// still find `session_id` in the JSON it just produced.
    #[test]
    fn data_event_serializes_session_id_as_camel_case() {
        let event = TerminalEvent::Data {
            session_id: "abc-123".to_string(),
            data: "aGVsbG8=".to_string(),
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert_eq!(
            json,
            r#"{"type":"data","sessionId":"abc-123","data":"aGVsbG8="}"#
        );
    }

    #[test]
    fn exit_event_serializes_session_id_as_camel_case() {
        let event = TerminalEvent::Exit {
            session_id: "abc-123".to_string(),
            exit_code: Some(0),
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert_eq!(
            json,
            r#"{"type":"exit","sessionId":"abc-123","exitCode":0}"#
        );
    }
}
