// Interactive Terminal feature: real PTY sessions the user types into
// directly, like a system Terminal.app / PowerShell window opened from
// inside ProcMix's console (`OutputPanel`).
//
// # Why this is a SEPARATE module from `core::executor`
//
// `core::executor` runs a SAVED, TEMPLATED script (`${var}` substitution),
// optionally elevated (sudo/UAC), with sensitive-value redaction and
// structured output extraction — it exists to safely automate a command the
// user authored once and reruns many times, and every run is driven by
// ProcMix itself (scheduler, workflow, or a one-shot "Run" click).
//
// A Terminal session has none of that shape: it is a raw, interactive shell
// the user types into by hand, exactly as if they had opened their OS's own
// terminal application. There is no template, no elevation flow (the user
// types `sudo` themselves and answers its password prompt inside the
// terminal, like everywhere else), no redaction (there is no fixed set of
// "sensitive variables" to redact — the whole session is opaque, unscripted
// user input), and no output extraction. Bolting this onto `ExecutorState`
// would conflate two fundamentally different trust models under one
// registry. See `docs/interactive-terminal.md` for the full write-up,
// including the explicit list of things this feature intentionally does
// NOT do (no HTTP/API exposure, no scheduler/workflow trigger, no
// elevation helper, no persistence across restarts).
//
// # Submodules
//   - `types`   — IPC DTOs (`TerminalEvent`), the session registry
//                 (`TerminalState`), and constants.
//   - `session` — spawn/write/resize/close and the app-shutdown teardown.

mod session;
mod types;

pub use session::{
    close_session, resize_session, shutdown_all_sync, spawn_session, write_to_session,
};
pub use types::{TerminalEvent, TerminalState, MAX_TERMINAL_SESSIONS, TERMINAL_EVENT};
