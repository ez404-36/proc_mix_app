// IPC-boundary types and constants for the command execution engine.
//
// Holds the serde DTOs (`ExecuteRequest`), the public `ExecutionEvent`
// stream variants, the typed `ExecutorError`, the internal completion
// types (`TerminalStatus`, `NodeOutcome`), the running-registry types
// (`RunningEntry`, `ExecutorState`), and the executor's stable string
// constants. These are re-exported from `executor/mod.rs` (`pub use
// types::*`) so callers keep their existing `crate::core::executor::*`
// import paths.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex};

use crate::core::extractor::ExtractedOutput;
use crate::core::parser::ParseError;
use crate::storage::commands::{CommandRecord, OutputSchemaRecord, VariableSpec};

pub const EXECUTION_EVENT: &str = "execution-event";

/// Where a command is executed.
///
/// - [`ExecutionTarget::Local`] (the serde default for a missing field): the
///   script runs on the local machine through the existing executor path.
///   Legacy `ExecuteRequest` payloads — which never carried a `target` — are
///   byte-identical to this variant.
/// - [`ExecutionTarget::Remote`]: the script runs on a remote host over SSH.
///   `alias` is a `Host` name from `~/.ssh/config`; the executor spawns the
///   system `ssh` binary with a fixed argv. The alias is allow-list validated
///   (`core::ssh::is_safe_alias`) before it reaches the process.
/// - [`ExecutionTarget::RemotePrompt`]: a UI-only state meaning "ask which
///   host at run time". The frontend MUST resolve it to a concrete `Remote`
///   before invoking; if it ever reaches the spawn path, the executor rejects
///   it with [`ERR_REMOTE_TARGET_UNRESOLVED`].
///
/// Serialised with `tag = "kind"`, `rename_all = "camelCase"` to mirror the
/// TS `ExecutionTarget` union (`{ kind: "local" }` / `{ kind: "remote",
/// alias }` / `{ kind: "remotePrompt" }`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExecutionTarget {
    #[default]
    Local,
    Remote {
        alias: String,
    },
    RemotePrompt,
}

/// Hard cap on the number of stdout bytes buffered for post-run output
/// extraction. Buffering is enabled ONLY when a command declares an
/// output schema (or runs as a workflow node), and the cap bounds memory
/// for a command that prints an unbounded stream. Extraction runs on the
/// captured prefix; the streamed `Stdout` events are unaffected.
pub const MAX_EXTRACTION_BUFFER_BYTES: usize = 1024 * 1024;

/// Hard cap on the total number of bytes retained in the combined
/// stdout+stderr capture buffer (see [`ExecuteRequest::capture_output`]).
/// Mirrors [`MAX_EXTRACTION_BUFFER_BYTES`] but for the interleaved capture a
/// backend caller (the scheduler) persists into history. Once the running
/// total reaches this cap, further lines are dropped from the buffer (the
/// live stream, when not silent, is unaffected). The producer applies a
/// second, smaller byte cap before storing (see
/// `storage::history::MAX_HISTORY_OUTPUT_BYTES`); this larger in-memory cap
/// just bounds the buffer itself.
pub const MAX_CAPTURE_BUFFER_BYTES: usize = 256 * 1024;

/// Hard cap on the number of captured lines retained for the
/// [`ExecuteRequest::capture_output`] buffer, independent of the byte cap.
/// Bounds memory for a command that prints many tiny lines.
pub const MAX_CAPTURE_LINES: usize = 5_000;

/// Hard cap on the number of trailing stdout bytes retained in
/// [`NodeOutcome::stdout_tail`] for workflow-node condition evaluation. A
/// `Stdout`-subject condition (`core::workflow_condition`) matches on this
/// bounded tail, never the unbounded stream, so a node that prints megabytes
/// cannot blow up memory just to be branched on. Kept small (64 KiB) because a
/// branch predicate inspects a recent slice — typically the final summary
/// line(s) of a build/test run.
pub const MAX_STDOUT_TAIL_BYTES: usize = 64 * 1024;

/// Sentinel error returned by [`spawn_execution`] when an elevated run
/// is requested on Unix but no admin password is stored in the OS
/// keychain yet. The frontend looks for this exact string (via
/// `triggerCommandRun`) and responds by opening the admin-password
/// prompt, then retries the run once. Any deviation in spelling
/// breaks that contract — keep it as a single ASCII identifier so a
/// future i18n / message-wrapping pass cannot accidentally mutate it.
///
/// [`spawn_execution`]: super::spawn_execution
pub const ERR_ADMIN_PASSWORD_REQUIRED: &str = "ADMIN_PASSWORD_REQUIRED";

/// Prefix for keychain backend errors that prevent the executor from
/// reading the password. The JS side surfaces these as a toast — they
/// indicate the OS keychain is unavailable (e.g. Linux without a D-Bus
/// session bus) and admin runs cannot proceed until the user fixes it.
pub const ERR_ADMIN_PASSWORD_BACKEND_PREFIX: &str = "ADMIN_PASSWORD_BACKEND:";

/// Prefix for the "configured working directory does not exist" error (M3).
/// Returned BEFORE the child is spawned when a command's `working_dir`
/// resolves to something that is not an existing directory, so the failure is
/// a precise, actionable message rather than an opaque spawn error. The
/// offending path is appended after the colon. A single ASCII identifier so a
/// future message-wrapping / i18n pass cannot mutate the part the JS side
/// matches on.
pub const ERR_INVALID_WORKING_DIR: &str = "INVALID_WORKING_DIR:";

/// Sentinel returned BEFORE the child is spawned when a remote
/// ([`ExecutionTarget::Remote`]) run carries an alias that fails the
/// allow-list check (`core::ssh::is_safe_alias`). The offending alias is
/// appended after the colon. A single ASCII identifier so a future
/// message-wrapping / i18n pass cannot mutate the part the JS side matches on.
pub const ERR_INVALID_REMOTE_TARGET: &str = "INVALID_REMOTE_TARGET:";

/// Sentinel returned BEFORE the child is spawned when an elevated run is
/// requested against a remote target. Local sudo/UAC does not map onto a
/// remote host, so remote elevation is unsupported in this version. The JS
/// side surfaces this as a toast and the form disables the elevation toggle
/// for remote commands.
pub const ERR_REMOTE_ELEVATION_UNSUPPORTED: &str = "REMOTE_ELEVATION_UNSUPPORTED";

/// Sentinel returned BEFORE the child is spawned when an
/// [`ExecutionTarget::RemotePrompt`] reaches the spawn path unresolved. The
/// frontend is responsible for opening a host picker and rewriting the target
/// to a concrete [`ExecutionTarget::Remote`] before invoking; this sentinel
/// is a defensive guard against that contract being violated.
pub const ERR_REMOTE_TARGET_UNRESOLVED: &str = "REMOTE_TARGET_UNRESOLVED";

/// Prefix returned BEFORE the child is spawned when parking the one-shot SSH
/// password in the keychain fails (no Secret Service on a Linux headless box,
/// permission denied, …). The backend error message follows the colon. The JS
/// side surfaces it as a toast. The keychain crate never includes the password
/// in its error variants, so the suffix is safe to display.
pub const ERR_SSH_PASSWORD_BACKEND_PREFIX: &str = "SSH_PASSWORD_BACKEND:";

// NOTE: `Debug` is intentionally NOT derived. `admin_password` holds the
// user's sudo password for the "Continue without saving" flow, and
// `variable_values` may hold secrets the user marked `sensitive`. A derived
// `Debug` would print both verbatim, so a single future `tracing` /
// `eprintln!("{req:?}")` or an error that formats the request would leak them.
// The hand-written `Debug` impl below redacts both. Wire format (serde) is
// unchanged — the real values still cross the IPC boundary.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub script: String,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub working_dir: Option<PathBuf>,
    pub env: Option<HashMap<String, String>>,
    pub command_id: Option<String>,
    /// Optional client-supplied execution id. When present, this is used
    /// verbatim as the id for the spawned run, so the caller can register
    /// state keyed on the id synchronously *before* invoking — eliminating
    /// the race where Started events arrive before the IPC promise
    /// resolves. The CommandForm live-run feature relies on this to mark
    /// runs as transient before the bridge sees the first event.
    /// When `None`, the executor generates a fresh UUID as before.
    pub execution_id: Option<String>,
    /// When `true`, spawn the script with elevated privileges:
    ///
    /// - Unix: via `sudo -S`, with the password read from the OS
    ///   keychain (`security::admin_password`) and written to sudo's
    ///   stdin. If the keychain has no entry, the executor returns
    ///   `Err("ADMIN_PASSWORD_REQUIRED")` BEFORE spawning so the UI
    ///   can prompt and retry.
    /// - Windows: via `Start-Process -Verb RunAs` (UAC). The keychain
    ///   is never read on Windows; the OS handles auth. Live
    ///   stdout/stderr capture is limited — see the elevated-spawn
    ///   branch for details.
    ///
    /// `#[serde(default)]` keeps existing JS callers (which don't yet
    /// know about this field) working unchanged: missing → false.
    #[serde(default)]
    pub elevated: bool,
    /// One-shot administrator password for this run only.
    ///
    /// When `Some` and `elevated == true` on Unix, the executor uses
    /// this value for sudo's stdin and DOES NOT touch the OS keychain
    /// at all — neither read nor write. The string lives for the
    /// duration of the spawn (it's moved into the writer task) and is
    /// never persisted anywhere. Use this for the "Continue" flow
    /// where the user authorises a single run without saving.
    ///
    /// When `None` (the historical behaviour), the executor falls back
    /// to reading from the keychain and returns the
    /// `ADMIN_PASSWORD_REQUIRED` sentinel when nothing is stored.
    ///
    /// Ignored on Windows — UAC handles auth there, so there is no
    /// password value to pass to the child.
    ///
    /// `#[serde(default)]` keeps payloads without the field
    /// backwards-compatible.
    #[serde(default)]
    pub admin_password: Option<String>,
    /// Variable specs referenced from `script`, `args`, `working_dir`,
    /// or `env` values via `${name}` / `${name:default}`. The executor
    /// consults each spec's `default_value` if the corresponding entry
    /// in `variable_values` is missing.
    ///
    /// `#[serde(default)]` keeps legacy payloads parsing cleanly —
    /// commands without variables omit the field entirely on the wire.
    #[serde(default)]
    pub variables: Vec<VariableSpec>,
    /// Per-run map of variable values supplied by the caller (prompt
    /// results merged with caller-provided values on the JS side). Wins
    /// over each spec's `default_value`. Missing entries fall back to
    /// the spec; missing entries with no default produce a
    /// `VariableResolution` error before the child is spawned.
    ///
    /// Uses `BTreeMap` for deterministic iteration in tests and logs.
    /// `#[serde(default)]` mirrors the variables field's contract.
    #[serde(default)]
    pub variable_values: BTreeMap<String, String>,
    /// When this execution is a node within a workflow run, the id of
    /// that run. The workflow runner sets it so every `execution-event`
    /// the node emits carries the run id, letting the frontend route the
    /// node's output into the single aggregated workflow process instead
    /// of a standalone terminal entry — deterministically, with no
    /// dependence on `workflow-event` vs `execution-event` arrival order.
    ///
    /// `None` for every direct (non-workflow) run, which is every
    /// existing caller. `#[serde(default)]` keeps legacy payloads —
    /// which never send this key — deserialising unchanged.
    #[serde(default)]
    pub workflow_run_id: Option<String>,
    /// Optional execution timeout in seconds. When set, the waiter task
    /// races a `tokio::time::sleep` against `child.wait()` and the
    /// cancel signal. If the sleep fires first, the child tree is killed
    /// and a `Finished` event is emitted with a special exit code of
    /// `None` (same as a signal kill). The frontend shows a "timed out"
    /// status based on the absence of an exit code combined with the
    /// `timedOut` flag on the `Finished` event.
    ///
    /// `None` means no limit. `#[serde(default)]` keeps legacy payloads
    /// parsing cleanly.
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    /// Optional output schema for this command. When present, the
    /// executor buffers stdout (up to [`MAX_EXTRACTION_BUFFER_BYTES`]),
    /// runs `core::extractor::extract` after the child finishes, and
    /// emits an `ExecutionEvent::Result`. When `None` (every legacy
    /// caller), no buffering or extraction happens and behaviour is
    /// byte-identical to before this feature. `#[serde(default)]` keeps
    /// legacy payloads parsing cleanly.
    #[serde(default)]
    pub output_schema: Option<OutputSchemaRecord>,
    /// When `true`, the waiter buffers EVERY stdout and stderr line (bounded
    /// by [`MAX_CAPTURE_BUFFER_BYTES`] and [`MAX_CAPTURE_LINES`]) and returns
    /// them on [`NodeOutcome::output`] so a backend caller (the scheduler) can
    /// persist the console output into a history record. This is independent of
    /// `output_schema`-driven extraction buffering: capture retains BOTH
    /// streams interleaved, while extraction buffers only stdout. When `false`
    /// (every legacy caller) no capture buffer is allocated and `output` is
    /// `None`. `#[serde(default)]` keeps legacy payloads parsing cleanly.
    #[serde(default)]
    pub capture_output: bool,
    /// When `true`, the executor still runs the process, still buffers capture
    /// (when `capture_output` is set), and still returns a [`NodeOutcome`] on
    /// the completion channel — but it SUPPRESSES every `execution-event`
    /// (`Started` / `Stdout` / `Stderr` / `Result` / terminal) so a planned
    /// (cron) fire does not stream into the live console. The history record is
    /// the source of truth for such runs. Manual "Run now" leaves this `false`
    /// so it streams exactly like a direct library run. `#[serde(default)]`
    /// keeps legacy payloads parsing cleanly.
    #[serde(default)]
    pub silent: bool,
    /// Where to run this command. Defaults to [`ExecutionTarget::Local`] when
    /// the field is absent, so every legacy payload (which never carried a
    /// `target`) runs locally exactly as before. A [`ExecutionTarget::Remote`]
    /// routes the spawn through the system `ssh` binary (see
    /// `command_build::build_remote_argv`); the alias is allow-list validated
    /// before the child is spawned. `#[serde(default)]` keeps legacy payloads
    /// parsing cleanly.
    #[serde(default)]
    pub target: ExecutionTarget,
    /// One-shot SSH password for this remote run only (the "enter password at
    /// run time" flow). When `Some` and the target is
    /// [`ExecutionTarget::Remote`] on Unix, the executor parks it in a
    /// throwaway OS-keychain entry (`security::ssh_oneshot`) keyed by the run
    /// id and hands the spawned `ssh` only that id via the `SSH_ASKPASS`
    /// helper — the password itself NEVER enters `ssh`'s argv or environment.
    /// The value is read-and-deleted by the helper and the run finalizer
    /// clears the entry regardless, so it is never persisted across runs.
    ///
    /// A blank/whitespace-only string is treated as absent. Ignored for a
    /// local target and on Windows (key/agent auth only there). Like
    /// `admin_password`, this is a secret: it is redacted from `Debug` and
    /// never logged or echoed into events/history. `#[serde(default)]` keeps
    /// payloads without the field backwards-compatible.
    ///
    /// See `docs/plans/ssh-remote-password-transient-keychain.md`.
    #[serde(default)]
    pub ssh_password: Option<String>,
}

impl std::fmt::Debug for ExecuteRequest {
    /// Hand-written so secrets never reach a log. `admin_password` and
    /// `ssh_password` are shown as a presence flag only (`Some("***")` /
    /// `None`), and every value of a `sensitive` variable is replaced with
    /// `***` in `variable_values`. All non-secret fields print normally. See
    /// the `redact` module and the H2/M1 entries in the `CHANGELOG.md`
    /// `[0.1.1]` security-hardening release.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let secrets =
            crate::core::redact::collect_sensitive_values(&self.variables, &self.variable_values);
        let redacted_values: BTreeMap<&String, String> = self
            .variable_values
            .iter()
            .map(|(k, v)| (k, crate::core::redact::redact_secrets(v, &secrets)))
            .collect();
        let admin_password = self
            .admin_password
            .as_ref()
            .map(|_| crate::core::redact::REDACTED);
        let ssh_password = self
            .ssh_password
            .as_ref()
            .map(|_| crate::core::redact::REDACTED);

        f.debug_struct("ExecuteRequest")
            .field("script", &self.script)
            .field("shell", &self.shell)
            .field("args", &self.args)
            .field("working_dir", &self.working_dir)
            .field("env", &self.env)
            .field("command_id", &self.command_id)
            .field("execution_id", &self.execution_id)
            .field("elevated", &self.elevated)
            .field("admin_password", &admin_password)
            .field("variables", &self.variables)
            .field("variable_values", &redacted_values)
            .field("workflow_run_id", &self.workflow_run_id)
            .field("timeout_seconds", &self.timeout_seconds)
            .field("output_schema", &self.output_schema)
            .field("capture_output", &self.capture_output)
            .field("silent", &self.silent)
            .field("target", &self.target)
            .field("ssh_password", &ssh_password)
            .finish()
    }
}

/// Per-call-site knobs for [`ExecuteRequest::for_command`]. Carries ONLY the
/// values that genuinely differ between the three backend run paths (workflow
/// node, scheduled fire, HTTP-API run); every security-sensitive default
/// (elevation detection, `admin_password`/`ssh_password = None`, the command's
/// saved target) is derived from the `CommandRecord` by the constructor, so it
/// cannot drift across call sites.
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// Client-supplied execution id used verbatim for the spawned run, so the
    /// caller can register state keyed on it before invoking.
    pub execution_id: String,
    /// Per-run variable values (prompt results merged with caller values).
    pub variable_values: BTreeMap<String, String>,
    /// Set ONLY when the run is a node within a workflow run, so every emitted
    /// `execution-event` routes into the aggregated workflow process. `None`
    /// for a standalone command run (scheduler / HTTP API).
    pub workflow_run_id: Option<String>,
    /// When `Some`, overrides the command's own `timeout_seconds` (used by the
    /// scheduler's per-run timeout). `None` falls back to `cmd.timeout_seconds`.
    pub timeout_override: Option<u64>,
    /// Buffer every stdout/stderr line for history persistence.
    pub capture_output: bool,
    /// Suppress every `execution-event` (planned/cron fire) — the history
    /// record is the source of truth for such runs.
    pub silent: bool,
}

impl ExecuteRequest {
    /// Build an `ExecuteRequest` for a backend-initiated run of `cmd`, applying
    /// the per-call-site knobs in `opts`. This is the single, authoritative
    /// builder shared by the workflow runner, the scheduler, and the HTTP-API
    /// handler — previously three near-identical copies that risked drifting on
    /// the security-sensitive defaults.
    ///
    /// Behaviour mirrors the UI/library request assembly in
    /// `src/utils/executor.ts` (shell, args, working dir, env, variables,
    /// elevated flag) so a backend run behaves identically to a direct library
    /// run.
    ///
    /// Security-critical defaults (kept byte-for-byte identical to the previous
    /// three copies):
    /// - `elevated`: the persisted `run_as_admin` flag OR a script whose LEADING
    ///   command is an inline-escalation tool (`sudo`/`doas`/`pkexec`). Without
    ///   the inline detection a `sudo …` script with `run_as_admin = false` runs
    ///   on the non-elevated path and the inline sudo dies needing a TTY.
    /// - `admin_password: None`: a backend run has no UI to prompt, so the
    ///   executor falls back to the OS keychain (surfacing the typed
    ///   `ADMIN_PASSWORD_REQUIRED` sentinel when empty).
    /// - `ssh_password: None`: a headless backend run cannot prompt for an SSH
    ///   password (remote password auth is interactive-prompt-only), so a
    ///   remote-targeted command must use key/agent auth.
    /// - `target`: the command's saved target; `unwrap_or_default()` maps a
    ///   record with no stored target (legacy rows) to `Local`.
    pub fn for_command(cmd: &CommandRecord, opts: RunOptions) -> Self {
        let env = cmd
            .env
            .as_ref()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        ExecuteRequest {
            script: cmd.script.clone(),
            shell: cmd.shell.clone(),
            args: cmd.args.clone(),
            working_dir: cmd.working_dir.as_ref().map(Into::into),
            env,
            command_id: Some(cmd.id.clone()),
            execution_id: Some(opts.execution_id),
            elevated: cmd.run_as_admin
                || crate::core::utility_help::detect_admin_escalation(&cmd.script),
            admin_password: None,
            variables: cmd.variables.clone(),
            variable_values: opts.variable_values,
            workflow_run_id: opts.workflow_run_id,
            timeout_seconds: opts.timeout_override.or(cmd.timeout_seconds),
            output_schema: cmd.output_schema.clone(),
            capture_output: opts.capture_output,
            silent: opts.silent,
            target: cmd.target.clone().unwrap_or_default(),
            ssh_password: None,
        }
    }
}

/// Typed error returned across the IPC boundary when the executor's
/// pre-spawn variable resolution fails. Serialised with a stable
/// `{ code, message }` shape so the JS bridge can dispatch on the code
/// instead of pattern-matching free-form strings — see the wire-format
/// regression test at the bottom of this module.
///
/// `tracing` calls in the executor must NEVER interpolate a resolved
/// value of a sensitive variable; this error carries only the variable
/// name (for `MissingVariable`) and a byte offset (for
/// `MalformedReference`), neither of which can leak user secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

impl ExecutorError {
    pub(super) fn from_parse(err: &ParseError) -> Self {
        let (code, message) = match err {
            ParseError::MissingVariable { name } => (
                "missingVariable".to_string(),
                format!("missing variable: {name}"),
            ),
            ParseError::MalformedReference { at } => (
                "malformedReference".to_string(),
                format!("malformed reference at byte {at}"),
            ),
        };
        Self { code, message }
    }

    /// Render the error as JSON so it can be returned through a Tauri
    /// command's `Result<_, String>` channel without losing the typed
    /// shape. `serde_json::to_string` cannot fail for this struct (no
    /// unrepresentable values), but we still propagate any encoding
    /// error verbatim rather than silently flattening to a plain
    /// string.
    pub fn to_wire_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!("{{\"code\":\"executorError\",\"message\":\"failed to encode error: {e}\"}}")
        })
    }
}

/// A single resolved variable for a run, carried on the `Started` event so
/// the OutputPanel can show what values the command actually ran with — even
/// for runs the frontend did NOT initiate (scheduler, workflow), which never
/// pre-register the execution and so have no other way to learn the values.
/// Mirrors the TS `ExecutionVariable` (camelCase on the wire). `value` is
/// already display-ready: a `sensitive` spec's value is masked to `***`, so
/// the raw secret never crosses the IPC boundary in this field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionVariableDto {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all_fields = "camelCase", tag = "kind")]
pub enum ExecutionEvent {
    #[serde(rename = "started")]
    Started {
        execution_id: String,
        pid: Option<u32>,
        command_id: Option<String>,
        /// Resolved variables (sensitive values pre-masked) this run was
        /// started with, so a backend-initiated run (scheduler / workflow)
        /// shows them in the console exactly like a direct library run.
        /// Omitted from the wire when the command declares no variables so
        /// legacy payloads stay byte-identical.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        variables: Vec<ExecutionVariableDto>,
        /// Set when this execution is a node within a workflow run; the
        /// frontend routes such events into the aggregated workflow
        /// process. Omitted from the wire (not sent as `null`) for direct
        /// runs so legacy payloads stay byte-identical.
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
    #[serde(rename = "stdout")]
    Stdout {
        execution_id: String,
        line: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
    #[serde(rename = "stderr")]
    Stderr {
        execution_id: String,
        line: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
    #[serde(rename = "finished")]
    Finished {
        execution_id: String,
        exit_code: Option<i32>,
        duration_ms: u64,
        command_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
    },
    #[serde(rename = "error")]
    Error {
        execution_id: String,
        message: String,
        command_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
    #[serde(rename = "cancelled")]
    Cancelled {
        execution_id: String,
        command_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
    /// Structured extraction result, emitted ONLY for runs whose command
    /// declared an output schema. Carries the extracted `fields` map and
    /// the chosen `return_value`, or an `error` string when extraction
    /// failed (the command itself still finished — extraction is
    /// non-fatal). Emitted AFTER all `Stdout`/`Stderr` events for the run
    /// and BEFORE the terminal `Finished` event, so the frontend can
    /// attach the result to the same execution before it is marked done.
    #[serde(rename = "result")]
    Result {
        execution_id: String,
        command_id: Option<String>,
        /// Extracted field map; empty object when extraction failed.
        fields: serde_json::Value,
        /// The command's return value; `null` when extraction failed.
        return_value: serde_json::Value,
        /// Human-readable extraction error, or `None` on success.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow_run_id: Option<String>,
    },
}

/// Terminal disposition of a single execution, reported on the optional
/// internal completion channel (see [`spawn_execution_with_completion`]).
/// Mirrors the three terminal `ExecutionEvent` variants without carrying
/// the streaming detail the workflow runner does not need.
///
/// [`spawn_execution_with_completion`]: super::spawn_execution_with_completion
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalStatus {
    /// Child exited on its own (any exit code, including non-zero). The
    /// code is carried separately in [`NodeOutcome::exit_code`].
    Finished,
    /// Child was killed by a user-initiated cancel, or exited via a
    /// signal (no exit code).
    Cancelled,
    /// `child.wait()` itself failed — the process could not be reaped.
    Error,
}

/// Internal completion signal for a single execution. Sent EXACTLY ONCE
/// on the optional `completion_tx` channel threaded through
/// [`spawn_execution_with_completion`], on every terminal path
/// (finished / cancelled / error), IN ADDITION to the public
/// `execution-event` emit. The workflow runner awaits this to learn a
/// node's exit code without scraping the Tauri event bus.
///
/// `exit_code` mirrors `ExecutionEvent::Finished::exit_code`: `Some(n)`
/// for a clean exit, `None` for a signal kill / cancel / wait error.
///
/// `extracted` carries the structured output when the run's command
/// declared an output schema AND extraction succeeded. The workflow
/// runner threads these fields into the next node's `variable_values`.
/// `None` when there was no schema or extraction failed (the workflow
/// still proceeds on `exit_code` alone). Not `Copy` because
/// [`ExtractedOutput`] owns heap data.
///
/// [`spawn_execution_with_completion`]: super::spawn_execution_with_completion
#[derive(Debug, Clone, PartialEq)]
pub struct NodeOutcome {
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
    pub extracted: Option<ExtractedOutput>,
    /// Wall-clock duration of the run in milliseconds. Mirrors
    /// `ExecutionEvent::Finished::duration_ms`. Always populated (the waiter
    /// times every run), so a backend caller can record it without scraping
    /// the event bus.
    pub duration_ms: u64,
    /// Captured stdout/stderr lines, interleaved in emission order. `Some`
    /// only when the request set [`ExecuteRequest::capture_output`]; `None`
    /// for every other run (no buffer is allocated). Bounded at capture time
    /// by [`MAX_CAPTURE_BUFFER_BYTES`] / [`MAX_CAPTURE_LINES`].
    pub output: Option<Vec<CapturedLine>>,
    /// Trailing slice of the run's (sensitive-redacted) stdout, retained ONLY
    /// for workflow nodes so the runner can evaluate `Stdout`-subject
    /// conditions (see `core::workflow_condition`). Bounded to the last
    /// [`MAX_STDOUT_TAIL_BYTES`] bytes. `None` for every non-workflow run (no
    /// extra buffering happens) and for workflow runs that produced no stdout.
    /// Already redacted — the streaming reader redacts each line before it is
    /// buffered — so a `sensitive` value never lands here verbatim.
    pub stdout_tail: Option<String>,
}

/// Which child stream a [`CapturedLine`] came from. Kept a small enum (rather
/// than a bare string) so the producer can't drift from the streaming
/// readers. Maps to the `"stdout"` / `"stderr"` tags the history layer
/// persists (see `storage::history::HistoryLogLine`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapturedStream {
    Stdout,
    Stderr,
    /// An app-injected separator line (e.g. the truncation marker). Maps to
    /// the `"meta"` tag the history layer recognises.
    Meta,
}

impl CapturedStream {
    /// Stable tag used by the history layer when persisting the line.
    pub fn as_str(self) -> &'static str {
        match self {
            CapturedStream::Stdout => "stdout",
            CapturedStream::Stderr => "stderr",
            CapturedStream::Meta => "meta",
        }
    }
}

/// One captured output line for [`NodeOutcome::output`]. Holds the
/// (already sensitive-redacted) text and which stream produced it. This is
/// the in-process mirror of `storage::history::HistoryLogLine`; the scheduler
/// maps one to the other before persisting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedLine {
    pub stream: CapturedStream,
    pub line: String,
}

/// Shared, bounded interleaved capture buffer for a single run. Both the
/// stdout and stderr reader tasks push into the SAME buffer (behind a
/// `std::sync::Mutex`) so the captured lines preserve their real emission
/// order across the two streams — a single `Arc<Mutex<_>>` is the simplest
/// way to interleave two concurrent producers deterministically.
///
/// Bounded by [`MAX_CAPTURE_BUFFER_BYTES`] (running byte total) and
/// [`MAX_CAPTURE_LINES`] (line count): once either cap is hit, further lines
/// are dropped from the buffer and `truncated` flips to `true` so the producer
/// can append a "…(truncated)" marker. The live stream (when not silent) is
/// unaffected — capping only bounds what we retain in memory.
#[derive(Debug, Default)]
pub struct CaptureBuffer {
    lines: Vec<CapturedLine>,
    bytes: usize,
    truncated: bool,
}

impl CaptureBuffer {
    /// Append a captured line, honouring the byte / line caps. A no-op once a
    /// cap has been hit (the line is dropped and `truncated` is set).
    pub fn push(&mut self, stream: CapturedStream, line: String) {
        if self.truncated {
            return;
        }
        if self.lines.len() >= MAX_CAPTURE_LINES
            || self.bytes.saturating_add(line.len()) > MAX_CAPTURE_BUFFER_BYTES
        {
            self.truncated = true;
            return;
        }
        self.bytes += line.len();
        self.lines.push(CapturedLine { stream, line });
    }

    /// Whether at least one line was dropped because a cap was reached.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// Consume the buffer, returning the captured lines in emission order.
    /// When a cap was hit, a trailing `meta`-stream `"…(truncated)"` marker
    /// line is appended so the consumer knows output was dropped.
    pub fn into_lines(self) -> Vec<CapturedLine> {
        let mut lines = self.lines;
        if self.truncated {
            lines.push(CapturedLine {
                stream: CapturedStream::Meta,
                line: TRUNCATION_MARKER.to_string(),
            });
        }
        lines
    }

    /// Clone the captured lines (with the same trailing truncation marker as
    /// [`into_lines`]) without consuming the buffer. Used only on the unlikely
    /// fallback path where the `Arc` could not be unwrapped.
    pub fn lines_snapshot(&self) -> Vec<CapturedLine> {
        let mut lines = self.lines.clone();
        if self.truncated {
            lines.push(CapturedLine {
                stream: CapturedStream::Meta,
                line: TRUNCATION_MARKER.to_string(),
            });
        }
        lines
    }
}

/// Trailing marker appended to a truncated capture so the consumer (and the
/// persisted history) shows that output was dropped at the in-memory cap.
pub const TRUNCATION_MARKER: &str = "…(truncated)";

/// Per-execution handle stored in `ExecutorState::running`.
///
/// The waiter task owns the `tokio::process::Child` permanently — that's
/// what lets us reap the exit status and emit `Finished` / `Cancelled`
/// without racing the cancel path. To cancel a run we send a unit value
/// on `cancel_tx`; the waiter selects between that and `child.wait()`
/// and, on cancel, performs the OS-level kill itself (group-wide on
/// Unix, single-process on Windows). The pgid is captured by the waiter
/// task at spawn time, not stored here, because nothing outside the
/// waiter needs it.
pub struct RunningEntry {
    pub cancel_tx: Option<oneshot::Sender<()>>,
    /// Process-group id of the spawned child, captured at spawn time. The
    /// waiter normally owns the kill, but on app shutdown the runtime is torn
    /// down before waiter tasks can run, so the exit hook needs to group-kill
    /// synchronously — it reads the pgid from here. `None` when `setsid`
    /// failed (the spawn falls back to a single-process kill). Unix only;
    /// Windows has no process-group kill in this model.
    #[cfg(unix)]
    pub pgid: Option<i32>,
}

pub struct ExecutorState {
    pub running: Arc<Mutex<HashMap<String, RunningEntry>>>,
}

impl ExecutorState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for ExecutorState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;
    use crate::core::parser;
    use crate::storage::commands::VariableSpec;

    /// The default `ExecutionTarget` is `Local`, so a missing field on any DTO
    /// (`#[serde(default)]`) keeps legacy payloads behaving exactly as before
    /// the remote-execution feature existed.
    #[test]
    fn execution_target_defaults_to_local() {
        assert_eq!(ExecutionTarget::default(), ExecutionTarget::Local);
    }

    /// `ExecutionTarget` serialises with `tag = "kind"` and camelCase variant
    /// names. The TS `ExecutionTarget` union depends on this exact shape;
    /// renaming a tag is a breaking IPC change.
    #[test]
    fn wire_format_execution_target_uses_kind_tag_camelcase() {
        let local = serde_json::to_value(ExecutionTarget::Local).unwrap();
        assert_eq!(local["kind"], "local");

        let remote = serde_json::to_value(ExecutionTarget::Remote {
            alias: "prod".into(),
        })
        .unwrap();
        assert_eq!(remote["kind"], "remote");
        assert_eq!(remote["alias"], "prod");

        let prompt = serde_json::to_value(ExecutionTarget::RemotePrompt).unwrap();
        assert_eq!(prompt["kind"], "remotePrompt");
        // Negative: snake_case spelling must not leak.
        assert!(prompt.get("remote_prompt").is_none());
    }

    /// Each variant round-trips from the wire JS will send.
    #[test]
    fn wire_format_execution_target_round_trips() {
        let local: ExecutionTarget =
            serde_json::from_value(serde_json::json!({ "kind": "local" })).unwrap();
        assert_eq!(local, ExecutionTarget::Local);

        let remote: ExecutionTarget = serde_json::from_value(
            serde_json::json!({ "kind": "remote", "alias": "db-1" }),
        )
        .unwrap();
        assert_eq!(
            remote,
            ExecutionTarget::Remote {
                alias: "db-1".into()
            }
        );

        let prompt: ExecutionTarget =
            serde_json::from_value(serde_json::json!({ "kind": "remotePrompt" })).unwrap();
        assert_eq!(prompt, ExecutionTarget::RemotePrompt);
    }

    /// The remote sentinel strings are part of the IPC contract — the JS side
    /// matches on them to dispatch error toasts. Lock their spellings so a
    /// refactor can't silently change what the frontend must recognise.
    #[test]
    fn remote_sentinels_are_pinned() {
        assert_eq!(ERR_INVALID_REMOTE_TARGET, "INVALID_REMOTE_TARGET:");
        assert_eq!(ERR_REMOTE_ELEVATION_UNSUPPORTED, "REMOTE_ELEVATION_UNSUPPORTED");
        assert_eq!(ERR_REMOTE_TARGET_UNRESOLVED, "REMOTE_TARGET_UNRESOLVED");
        assert_eq!(ERR_SSH_PASSWORD_BACKEND_PREFIX, "SSH_PASSWORD_BACKEND:");
    }

    #[test]
    fn wire_format_started_uses_camelcase() {
        let e = ExecutionEvent::Started {
            execution_id: "abc".into(),
            pid: Some(42),
            command_id: Some("cmd-1".into()),
            variables: Vec::new(),
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "started");
        assert_eq!(json["executionId"], "abc");
        assert!(json["pid"].is_number());
        assert_eq!(json["commandId"], "cmd-1");
        assert!(json.get("execution_id").is_none());
        assert!(json.get("command_id").is_none());
        // Absent workflow_run_id is omitted entirely (no `null` on the wire),
        // keeping direct-run payloads byte-identical to pre-feature.
        assert!(json.get("workflowRunId").is_none());
        assert!(json.get("workflow_run_id").is_none());
        // Empty variables list is omitted entirely (legacy payloads unchanged).
        assert!(json.get("variables").is_none());
    }

    #[test]
    fn wire_format_started_includes_masked_variables() {
        let e = ExecutionEvent::Started {
            execution_id: "abc".into(),
            pid: None,
            command_id: None,
            variables: vec![
                ExecutionVariableDto {
                    name: "host".into(),
                    value: "example.com".into(),
                    sensitive: false,
                },
                ExecutionVariableDto {
                    name: "token".into(),
                    value: "***".into(),
                    sensitive: true,
                },
            ],
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        let vars = json["variables"].as_array().expect("variables present");
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0]["name"], "host");
        assert_eq!(vars[0]["value"], "example.com");
        assert_eq!(vars[0]["sensitive"], false);
        // Sensitive value must already be masked on the wire.
        assert_eq!(vars[1]["name"], "token");
        assert_eq!(vars[1]["value"], "***");
        assert_eq!(vars[1]["sensitive"], true);
    }

    #[test]
    fn wire_format_stdout_uses_camelcase() {
        let e = ExecutionEvent::Stdout {
            execution_id: "abc".into(),
            line: "hello".into(),
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "stdout");
        assert_eq!(json["executionId"], "abc");
        assert_eq!(json["line"], "hello");
        assert!(json.get("execution_id").is_none());
        assert!(json.get("workflowRunId").is_none());
    }

    #[test]
    fn wire_format_stderr_uses_camelcase() {
        let e = ExecutionEvent::Stderr {
            execution_id: "abc".into(),
            line: "boom".into(),
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "stderr");
        assert_eq!(json["executionId"], "abc");
        assert_eq!(json["line"], "boom");
        assert!(json.get("execution_id").is_none());
        assert!(json.get("workflowRunId").is_none());
    }

    #[test]
    fn wire_format_finished_uses_camelcase() {
        let e = ExecutionEvent::Finished {
            execution_id: "abc".into(),
            exit_code: Some(0),
            duration_ms: 123,
            command_id: Some("cmd-1".into()),
            workflow_run_id: None,
            timed_out: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "finished");
        assert_eq!(json["executionId"], "abc");
        assert_eq!(json["exitCode"], 0);
        assert_eq!(json["durationMs"], 123);
        assert_eq!(json["commandId"], "cmd-1");
        assert!(json.get("execution_id").is_none());
        assert!(json.get("exit_code").is_none());
        assert!(json.get("duration_ms").is_none());
        assert!(json.get("command_id").is_none());
        assert!(json.get("workflowRunId").is_none());
        assert!(json.get("timedOut").is_none());
    }

    #[test]
    fn wire_format_error_uses_camelcase() {
        let e = ExecutionEvent::Error {
            execution_id: "abc".into(),
            message: "boom".into(),
            command_id: None,
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "error");
        assert_eq!(json["executionId"], "abc");
        assert_eq!(json["message"], "boom");
        assert!(json.get("execution_id").is_none());
        assert!(json.get("workflowRunId").is_none());
    }

    #[test]
    fn wire_format_cancelled_uses_camelcase() {
        let e = ExecutionEvent::Cancelled {
            execution_id: "abc".into(),
            command_id: None,
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "cancelled");
        assert_eq!(json["executionId"], "abc");
        assert!(json.get("workflowRunId").is_none());
    }

    /// The `result` event must serialise with `kind: "result"`, camelCase
    /// keys, and omit `error`/`workflowRunId` when absent. The frontend's
    /// result-routing depends on this exact shape.
    #[test]
    fn wire_format_result_uses_camelcase() {
        let e = ExecutionEvent::Result {
            execution_id: "abc".into(),
            command_id: Some("cmd-1".into()),
            fields: serde_json::json!({ "count": 3 }),
            return_value: serde_json::json!(3),
            error: None,
            workflow_run_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "result");
        assert_eq!(json["executionId"], "abc");
        assert_eq!(json["commandId"], "cmd-1");
        assert_eq!(json["fields"]["count"], 3);
        assert_eq!(json["returnValue"], 3);
        // Absent optionals are omitted, not serialised as null.
        assert!(json.get("error").is_none());
        assert!(json.get("workflowRunId").is_none());
        assert!(json.get("return_value").is_none());
    }

    /// On extraction failure the `result` event carries `error` and the
    /// frontend can show it without a structured payload.
    #[test]
    fn wire_format_result_carries_error_when_present() {
        let e = ExecutionEvent::Result {
            execution_id: "abc".into(),
            command_id: None,
            fields: serde_json::json!({}),
            return_value: serde_json::Value::Null,
            error: Some("invalid JSON output: x".into()),
            workflow_run_id: Some("run-1".into()),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["error"], "invalid JSON output: x");
        assert_eq!(json["workflowRunId"], "run-1");
    }

    /// When a node runs inside a workflow, every event carries the run id
    /// as camelCase `workflowRunId`. This is the wire contract the frontend
    /// routing rule depends on — a rename here would break workflow output
    /// aggregation (the steps would fragment into separate terminal
    /// entries again).
    #[test]
    fn wire_format_events_carry_workflow_run_id_when_set() {
        let started = ExecutionEvent::Started {
            execution_id: "abc".into(),
            pid: None,
            command_id: None,
            variables: Vec::new(),
            workflow_run_id: Some("run-1".into()),
        };
        let sj = serde_json::to_value(&started).unwrap();
        assert_eq!(sj["workflowRunId"], "run-1");
        assert!(sj.get("workflow_run_id").is_none());

        let stdout = ExecutionEvent::Stdout {
            execution_id: "abc".into(),
            line: "hi".into(),
            workflow_run_id: Some("run-1".into()),
        };
        assert_eq!(
            serde_json::to_value(&stdout).unwrap()["workflowRunId"],
            "run-1"
        );

        let finished = ExecutionEvent::Finished {
            execution_id: "abc".into(),
            exit_code: Some(0),
            duration_ms: 1,
            command_id: None,
            workflow_run_id: Some("run-1".into()),
            timed_out: None,
        };
        assert_eq!(
            serde_json::to_value(&finished).unwrap()["workflowRunId"],
            "run-1"
        );
    }

    #[test]
    fn wire_format_execute_request_uses_camelcase() {
        let req = ExecuteRequest {
            script: "echo hi".into(),
            shell: Some("bash".into()),
            args: None,
            working_dir: Some(PathBuf::from("/tmp")),
            env: None,
            command_id: Some("cmd-1".into()),
            execution_id: Some("exec-7".into()),
            elevated: true,
            admin_password: Some("hunter2".into()),
            variables: Vec::new(),
            variable_values: BTreeMap::new(),
            workflow_run_id: None,
            timeout_seconds: Some(60),
            output_schema: None,
            capture_output: false,
            silent: false,
            target: ExecutionTarget::Local,
            ssh_password: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json["workingDir"].is_string());
        assert!(json["commandId"].is_string());
        assert_eq!(json["executionId"], "exec-7");
        assert_eq!(json["elevated"], true);
        assert_eq!(json["adminPassword"], "hunter2");
        assert_eq!(json["timeoutSeconds"], 60);
        assert!(json.get("working_dir").is_none());
        assert!(json.get("command_id").is_none());
        assert!(json.get("execution_id").is_none());
        assert!(json.get("admin_password").is_none());
        assert!(json.get("timeout_seconds").is_none());
        // New camelCase keys are present (even when empty).
        assert!(json.get("variables").is_some());
        assert!(json.get("variableValues").is_some());
        // Negative: their snake_case forms must not leak through.
        assert!(json.get("variable_values").is_none());
    }

    /// H2: the hand-written `Debug` impl must NOT print the sudo password or
    /// the one-shot SSH password, and must redact `sensitive` variable values,
    /// while still serialising the real values over the wire (covered by the
    /// camelCase test above).
    #[test]
    fn debug_redacts_admin_password_and_sensitive_values() {
        let mut variable_values = BTreeMap::new();
        variable_values.insert("token".to_string(), "s3cr3t-token".to_string());
        variable_values.insert("name".to_string(), "alice".to_string());
        let req = ExecuteRequest {
            script: "echo ${name}".into(),
            shell: Some("bash".into()),
            args: None,
            working_dir: None,
            env: None,
            command_id: Some("cmd-1".into()),
            execution_id: None,
            elevated: true,
            admin_password: Some("hunter2".into()),
            variables: vec![
                VariableSpec {
                    name: "token".into(),
                    default_value: None,
                    prompt_at_runtime: false,
                    description: None,
                    sensitive: true,
                },
                VariableSpec {
                    name: "name".into(),
                    default_value: None,
                    prompt_at_runtime: false,
                    description: None,
                    sensitive: false,
                },
            ],
            variable_values,
            workflow_run_id: None,
            timeout_seconds: None,
            output_schema: None,
            capture_output: false,
            silent: false,
            target: ExecutionTarget::Local,
            ssh_password: Some("sshpw-secret".into()),
        };
        let dbg = format!("{req:?}");
        // The sudo password must never appear.
        assert!(!dbg.contains("hunter2"), "admin password leaked: {dbg}");
        // The one-shot SSH password must never appear.
        assert!(
            !dbg.contains("sshpw-secret"),
            "ssh password leaked: {dbg}"
        );
        // The sensitive variable value must never appear.
        assert!(
            !dbg.contains("s3cr3t-token"),
            "sensitive value leaked: {dbg}"
        );
        // The placeholder is present and a non-sensitive value still shows.
        assert!(dbg.contains("***"), "expected redaction placeholder: {dbg}");
        assert!(
            dbg.contains("alice"),
            "non-sensitive value should remain: {dbg}"
        );
    }

    /// A request carrying a workflow run id serialises it as camelCase
    /// `workflowRunId`. The workflow runner sets this so every node's
    /// `execution-event` can be folded into one aggregated process.
    #[test]
    fn wire_format_execute_request_round_trips_workflow_run_id() {
        let json = serde_json::json!({
            "script": "whoami",
            "workflowRunId": "run-9",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.workflow_run_id.as_deref(), Some("run-9"));
    }

    /// Every existing JS caller (direct command runs) never sends
    /// `workflowRunId`. `#[serde(default)]` must keep them parsing with
    /// `None` — otherwise every non-workflow run would fail to deserialize.
    #[test]
    fn wire_format_execute_request_workflow_run_id_defaults_to_none_when_absent() {
        let json = serde_json::json!({
            "script": "whoami",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.workflow_run_id.is_none());
    }

    /// Legacy JS callers that predate the variables feature send neither
    /// `variables` nor `variableValues`. `#[serde(default)]` must keep
    /// them deserialising into empty containers — otherwise every
    /// existing payload would suddenly fail to parse.
    #[test]
    fn wire_format_execute_request_variables_default_when_absent() {
        let json = serde_json::json!({
            "script": "whoami",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.variables.is_empty());
        assert!(req.variable_values.is_empty());
    }

    /// `variableValues` round-trips through the wire as camelCase. The
    /// JS side will send `{ variableValues: { foo: "bar" } }`; the Rust
    /// deserialised form must surface that as the corresponding
    /// snake_case field on the struct.
    #[test]
    fn wire_format_execute_request_round_trips_variable_values() {
        let json = serde_json::json!({
            "script": "echo ${who}",
            "variableValues": { "who": "world" },
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(
            req.variable_values.get("who").map(String::as_str),
            Some("world")
        );
    }

    /// `ExecutorError` serialises as `{ "code": "...", "message": "..." }`
    /// with camelCase keys. The JS bridge looks at `code` to dispatch;
    /// any rename here breaks the variable-resolution error surface.
    #[test]
    fn wire_format_executor_error_uses_camelcase() {
        let err = ExecutorError {
            code: "missingVariable".into(),
            message: "missing variable: who".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "missingVariable");
        assert_eq!(json["message"], "missing variable: who");
        // Negative: snake_case must not leak (no fields use it anyway,
        // but lock the contract).
        assert!(json.get("Code").is_none());
        assert!(json.get("Message").is_none());
    }

    /// Mapping ParseError → ExecutorError preserves the variant code as
    /// a stable camelCase string. The JS side dispatches on these exact
    /// values, so changing them is a breaking IPC change.
    #[test]
    fn executor_error_from_parse_codes_are_stable() {
        let missing =
            ExecutorError::from_parse(&parser::ParseError::MissingVariable { name: "x".into() });
        assert_eq!(missing.code, "missingVariable");
        assert!(missing.message.contains("x"));

        let malformed =
            ExecutorError::from_parse(&parser::ParseError::MalformedReference { at: 7 });
        assert_eq!(malformed.code, "malformedReference");
        assert!(malformed.message.contains("7"));
    }

    /// `to_wire_string` produces valid JSON that round-trips back into
    /// the same struct. The Tauri command channel returns a `String`,
    /// so verifying serialisability here catches encoding mistakes
    /// before they reach the JS bridge.
    #[test]
    fn executor_error_to_wire_string_round_trips() {
        let err = ExecutorError {
            code: "missingVariable".into(),
            message: "missing variable: who".into(),
        };
        let wire = err.to_wire_string();
        let parsed: serde_json::Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed["code"], "missingVariable");
        assert_eq!(parsed["message"], "missing variable: who");
    }

    /// One-shot `adminPassword` deserialises into the optional field on
    /// the Rust side. This is the wire contract the "Continue (don't
    /// save)" button relies on — a JS-side rename or a serde
    /// `rename_all` change must break this test, not the production
    /// admin-run flow.
    #[test]
    fn wire_format_execute_request_round_trips_admin_password() {
        let json = serde_json::json!({
            "script": "whoami",
            "elevated": true,
            "adminPassword": "hunter2",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.admin_password.as_deref(), Some("hunter2"));
    }

    /// Existing JS callers that never set `adminPassword` continue to
    /// deserialise with `None`. Locks the `#[serde(default)]` contract:
    /// without it, every legacy elevated run would suddenly fail to
    /// parse the request.
    #[test]
    fn wire_format_execute_request_admin_password_defaults_to_none_when_absent() {
        let json = serde_json::json!({
            "script": "whoami",
            "elevated": true,
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.admin_password.is_none());
    }

    /// One-shot `sshPassword` deserialises into the optional field on the Rust
    /// side. This is the wire contract the "enter password at run time" flow
    /// relies on — a JS-side rename or a serde `rename_all` change must break
    /// this test, not the production remote-run flow.
    #[test]
    fn wire_format_execute_request_round_trips_ssh_password() {
        let json = serde_json::json!({
            "script": "uptime",
            "target": { "kind": "remote", "alias": "prod" },
            "sshPassword": "hunter2",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.ssh_password.as_deref(), Some("hunter2"));
    }

    /// Existing JS callers that never set `sshPassword` continue to
    /// deserialise with `None`. Locks the `#[serde(default)]` contract so a
    /// legacy (key-auth) remote run keeps parsing.
    #[test]
    fn wire_format_execute_request_ssh_password_defaults_to_none_when_absent() {
        let json = serde_json::json!({ "script": "whoami" });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.ssh_password.is_none());
    }

    /// `elevated:true` survives a JSON round-trip — the JS side sends
    /// it as a plain camelCase boolean and the executor must observe
    /// it as `true`. Locks the contract so a future serde rename can't
    /// silently break the admin path.
    #[test]
    fn wire_format_execute_request_round_trips_elevated_true() {
        let json = serde_json::json!({
            "script": "whoami",
            "elevated": true,
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.elevated);
    }

    /// Legacy JS callers that predate the elevation feature send no
    /// `elevated` key. `#[serde(default)]` must keep them working —
    /// otherwise every existing run would suddenly fail to deserialize.
    #[test]
    fn wire_format_execute_request_elevated_defaults_to_false_when_absent() {
        let json = serde_json::json!({
            "script": "whoami",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(!req.elevated);
    }

    /// Legacy callers send neither `captureOutput` nor `silent`.
    /// `#[serde(default)]` must keep them deserialising with both `false`,
    /// so a pre-feature payload behaves exactly as before (no capture, full
    /// streaming).
    #[test]
    fn wire_format_execute_request_capture_and_silent_default_to_false_when_absent() {
        let json = serde_json::json!({
            "script": "whoami",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(!req.capture_output);
        assert!(!req.silent);
    }

    /// `captureOutput` / `silent` round-trip as camelCase booleans. The
    /// scheduler sends these so a planned fire captures output and stays off
    /// the live console.
    #[test]
    fn wire_format_execute_request_round_trips_capture_and_silent() {
        let json = serde_json::json!({
            "script": "whoami",
            "captureOutput": true,
            "silent": true,
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert!(req.capture_output);
        assert!(req.silent);
    }

    /// The bounded [`CaptureBuffer`] retains lines in push order and drops
    /// further lines once the line-count cap is hit, flagging truncation.
    #[test]
    fn capture_buffer_bounds_line_count_and_flags_truncation() {
        let mut buf = CaptureBuffer::default();
        for i in 0..(MAX_CAPTURE_LINES + 10) {
            buf.push(CapturedStream::Stdout, format!("line {i}"));
        }
        assert!(buf.is_truncated(), "buffer should report truncation");
        let lines = buf.into_lines();
        // Capped data lines + a single trailing truncation marker.
        assert_eq!(
            lines.len(),
            MAX_CAPTURE_LINES + 1,
            "capped data lines plus the truncation marker"
        );
        assert_eq!(lines[0].line, "line 0");
        assert_eq!(lines[0].stream, CapturedStream::Stdout);
        let marker = lines.last().expect("a marker line");
        assert_eq!(marker.stream, CapturedStream::Meta);
        assert_eq!(marker.line, TRUNCATION_MARKER);
    }

    /// Interleaved stdout/stderr pushes preserve insertion order and tag each
    /// line with its originating stream.
    #[test]
    fn capture_buffer_preserves_interleaved_order_and_stream_tags() {
        let mut buf = CaptureBuffer::default();
        buf.push(CapturedStream::Stdout, "out-1".into());
        buf.push(CapturedStream::Stderr, "err-1".into());
        buf.push(CapturedStream::Stdout, "out-2".into());
        assert!(!buf.is_truncated());
        let lines = buf.into_lines();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].stream, CapturedStream::Stdout);
        assert_eq!(lines[0].line, "out-1");
        assert_eq!(lines[1].stream, CapturedStream::Stderr);
        assert_eq!(lines[1].line, "err-1");
        assert_eq!(lines[2].stream, CapturedStream::Stdout);
        assert_eq!(lines[2].line, "out-2");
    }

    /// Round-trip a request whose `executionId` is provided by the client.
    /// The deserialized struct must surface it as `execution_id` so the
    /// executor can honor it instead of generating its own UUID.
    #[test]
    fn wire_format_execute_request_round_trips_execution_id() {
        let json = serde_json::json!({
            "script": "echo hi",
            "executionId": "client-uuid-42",
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.execution_id.as_deref(), Some("client-uuid-42"));
    }

    /// Lock the exact sentinel strings the JS bridge looks for. The
    /// frontend compares the error message with `===` (no
    /// substring matching), so any deviation here — a trailing space,
    /// a colon, a renamed identifier — breaks the prompt-and-retry
    /// flow and the user gets a raw error toast instead.
    #[test]
    fn admin_password_required_sentinel_is_exact() {
        assert_eq!(ERR_ADMIN_PASSWORD_REQUIRED, "ADMIN_PASSWORD_REQUIRED");
    }

    #[test]
    fn admin_password_backend_prefix_is_exact() {
        assert_eq!(ERR_ADMIN_PASSWORD_BACKEND_PREFIX, "ADMIN_PASSWORD_BACKEND:");
    }

    /// A legacy `ExecuteRequest` payload (no `target`) deserialises with the
    /// default `Local` target — every existing JS caller relies on this.
    #[test]
    fn wire_format_execute_request_target_defaults_to_local_when_absent() {
        let json = serde_json::json!({ "script": "whoami" });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.target, ExecutionTarget::Local);
    }

    /// A remote target round-trips as camelCase `target` with the `kind` tag.
    /// This is the wire contract the executor's remote-spawn branch reads.
    #[test]
    fn wire_format_execute_request_round_trips_remote_target() {
        let json = serde_json::json!({
            "script": "uptime",
            "target": { "kind": "remote", "alias": "prod-web" },
        });
        let req: ExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(
            req.target,
            ExecutionTarget::Remote {
                alias: "prod-web".into()
            }
        );

        // And serialising it back keeps the exact shape JS sent.
        let back = serde_json::to_value(&req).unwrap();
        assert_eq!(back["target"]["kind"], "remote");
        assert_eq!(back["target"]["alias"], "prod-web");
    }
}
