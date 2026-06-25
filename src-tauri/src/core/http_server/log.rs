// Request log for the built-in HTTP server.
//
// Three sinks, all best-effort and all secret-free:
//   1. An in-memory RING BUFFER of the last `RING_CAPACITY` request summaries,
//      snapshot-readable by the `list_request_log` Tauri command for the UI.
//   2. A Tauri EVENT (`http-server-log`) emitted per request so an open
//      mini-panel updates live without polling.
//   3. A FILE (`<app_log_dir>/http-server.log`), append-only with size-based
//      rotation, so a request trail survives a restart.
//
// SECURITY: a `RequestLogEntry` carries request metadata — method, path,
// status, remote address, the resolved entity NAME — and OPTIONALLY a
// pre-redacted request summary and a response summary. The request summary is
// built by the handler (`handlers::redact_command_variables` etc.), which has
// the command's `VariableSpec`s and therefore masks every `sensitive` variable
// value to `***` BEFORE it ever reaches this module. This module performs NO
// redaction of its own — it trusts the caller to have masked secrets, and the
// `request_summary` field is the ONLY place a user-supplied value may appear.
// The Bearer token and raw bodies are never passed in. See docs/http-server.md.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// Number of most-recent request summaries retained in the in-memory ring.
/// Bounds memory regardless of traffic; the UI shows a live tail of this size.
const RING_CAPACITY: usize = 200;

/// Tauri event name carrying a single [`RequestLogEntry`] to the live UI log.
pub const HTTP_SERVER_LOG_EVENT: &str = "http-server-log";

/// Max bytes the on-disk `http-server.log` grows to before it is rotated to
/// `http-server.log.1` (single generation). Keeps the trail bounded.
const LOG_FILE_MAX_BYTES: u64 = 1024 * 1024;

/// A single request summary. Metadata only — see the module docs for why this
/// type carries no secret-bearing field. Serialised camelCase to match the TS
/// `RequestLogEntry` type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogEntry {
    /// RFC 3339 timestamp of when the request completed.
    pub ts: String,
    /// HTTP method (`GET` / `POST`).
    pub method: String,
    /// Matched route path (e.g. `/api/command/{ref}/run`) — never a raw query
    /// string, so no user value beyond a non-secret slug appears.
    pub path: String,
    /// Final HTTP status code.
    pub status: u16,
    /// Peer socket address (`ip:port`), or `"-"` when unavailable.
    pub remote_addr: String,
    /// Resolved entity display name, when the request addressed a known
    /// command/workflow; `None` for health checks, auth failures, and 404s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_name: Option<String>,
    /// Human-readable summary of the request body, ALREADY REDACTED by the
    /// handler: every `sensitive` variable value is masked to `***`; non-secret
    /// values are shown verbatim (e.g. `wait=true; name=alice; token=***`).
    /// `None` for requests with no meaningful body (GET, health, errors before
    /// resolution). This is the only field that may carry a user value, and it
    /// is non-secret by construction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_summary: Option<String>,
    /// Human-readable summary of the response the server returned (e.g.
    /// `status=succeeded exitCode=0` or `error=notFound`). The API response
    /// never contains command stdout or secrets, so this is logged verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_summary: Option<String>,
}

/// In-memory ring buffer of recent request summaries plus the resolved log
/// file path. Held inside [`super::state::HttpServerState`]. The `Mutex` is a
/// `std::sync::Mutex` (not tokio): each push/snapshot is a brief, await-free
/// critical section.
#[derive(Debug, Default)]
pub struct RequestLog {
    ring: Mutex<VecDeque<RequestLogEntry>>,
    /// Resolved `<app_log_dir>/http-server.log`. `None` until the lifecycle
    /// layer sets it (the app log dir is only known once the `AppHandle`
    /// exists); file logging is skipped while `None`.
    log_path: Mutex<Option<PathBuf>>,
}

impl RequestLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point the file sink at `<app_log_dir>/http-server.log`. Called once by
    /// the lifecycle layer when the server starts (the dir is AppHandle-derived).
    pub fn set_log_path(&self, path: PathBuf) {
        if let Ok(mut guard) = self.log_path.lock() {
            *guard = Some(path);
        }
    }

    /// Record one request: push into the ring (evicting the oldest past
    /// capacity), emit the live event, and append to the file. Every sink is
    /// best-effort — a poisoned lock or an IO error is swallowed so logging can
    /// never fail a request.
    pub fn record<R: Runtime>(&self, app: &AppHandle<R>, entry: RequestLogEntry) {
        if let Ok(mut ring) = self.ring.lock() {
            if ring.len() >= RING_CAPACITY {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }

        // Live UI event (best-effort).
        let _ = app.emit(HTTP_SERVER_LOG_EVENT, &entry);

        // File sink (best-effort).
        self.append_to_file(&entry);
    }

    /// Clear the in-memory ring (the "recent requests" the UI shows). The
    /// on-disk `http-server.log` is left untouched — it is a persistent audit
    /// trail, not the UI's live tail, and is bounded by its own rotation. Used
    /// by the `clear_request_log` Tauri command.
    pub fn clear(&self) {
        if let Ok(mut ring) = self.ring.lock() {
            ring.clear();
        }
    }

    /// Snapshot the ring oldest-first for the `list_request_log` command.
    pub fn snapshot(&self) -> Vec<RequestLogEntry> {
        self.ring
            .lock()
            .map(|ring| ring.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn append_to_file(&self, entry: &RequestLogEntry) {
        let Ok(guard) = self.log_path.lock() else {
            return;
        };
        let Some(path) = guard.as_ref() else {
            return;
        };

        // Rotate if the file has grown past the cap. Single generation: the
        // previous `.1` is overwritten. Best-effort — ignore rotation errors.
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() >= LOG_FILE_MAX_BYTES {
                let rotated = path.with_extension("log.1");
                let _ = std::fs::rename(path, rotated);
            }
        }

        let line = format!(
            "{} {} {} {} {}{}{}{}\n",
            entry.ts,
            entry.remote_addr,
            entry.method,
            entry.status,
            entry.path,
            entry
                .entity_name
                .as_deref()
                .map(|n| format!(" [{n}]"))
                .unwrap_or_default(),
            entry
                .request_summary
                .as_deref()
                .map(|s| format!(" req=({s})"))
                .unwrap_or_default(),
            entry
                .response_summary
                .as_deref()
                .map(|s| format!(" resp=({s})"))
                .unwrap_or_default(),
        );

        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(status: u16) -> RequestLogEntry {
        RequestLogEntry {
            ts: "2026-06-24T00:00:00Z".to_string(),
            method: "POST".to_string(),
            path: "/api/command/{ref}/run".to_string(),
            status,
            remote_addr: "127.0.0.1:1234".to_string(),
            entity_name: Some("Deploy".to_string()),
            request_summary: Some("wait=true; token=***".to_string()),
            response_summary: Some("status=succeeded exitCode=0".to_string()),
        }
    }

    /// The ring must retain only the most-recent `RING_CAPACITY` entries,
    /// evicting the oldest, and snapshot them oldest-first.
    #[test]
    fn ring_evicts_oldest_past_capacity() {
        let log = RequestLog::new();
        // Push capacity + 5 entries; tag each via the status code so we can
        // verify which survived.
        for i in 0..(RING_CAPACITY as u16 + 5) {
            if let Ok(mut ring) = log.ring.lock() {
                if ring.len() >= RING_CAPACITY {
                    ring.pop_front();
                }
                ring.push_back(entry(i));
            }
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), RING_CAPACITY, "ring is capped at capacity");
        // The first 5 (statuses 0..5) were evicted; the oldest survivor is 5.
        assert_eq!(snap.first().unwrap().status, 5);
        assert_eq!(
            snap.last().unwrap().status,
            RING_CAPACITY as u16 + 4,
            "newest entry is last"
        );
    }

    /// `clear` empties the ring so a subsequent snapshot is empty.
    #[test]
    fn clear_empties_the_ring() {
        let log = RequestLog::new();
        for i in 0..3 {
            if let Ok(mut ring) = log.ring.lock() {
                ring.push_back(entry(i));
            }
        }
        assert_eq!(log.snapshot().len(), 3);
        log.clear();
        assert!(log.snapshot().is_empty(), "ring is empty after clear");
    }

    /// `RequestLogEntry` serialises camelCase and omits a `None` entityName.
    #[test]
    fn entry_wire_format_is_camel_case() {
        let mut e = entry(202);
        e.entity_name = None;
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"remoteAddr\""), "remote_addr → remoteAddr");
        assert!(
            !json.contains("entityName"),
            "a None entity name is omitted from the wire"
        );
        assert!(!json.contains("entity_name"), "no snake_case leaks");
    }

    /// The request/response summaries serialise camelCase, are carried verbatim
    /// (the masking already happened upstream), and are omitted when `None`.
    #[test]
    fn summaries_round_trip_camel_case_and_omit_none() {
        let e = entry(200);
        let json = serde_json::to_string(&e).unwrap();
        assert!(
            json.contains("\"requestSummary\""),
            "request_summary → requestSummary"
        );
        assert!(
            json.contains("\"responseSummary\""),
            "response_summary → responseSummary"
        );
        // The already-masked secret is preserved exactly (this module never
        // re-redacts).
        assert!(json.contains("token=***"));

        let mut bare = entry(200);
        bare.request_summary = None;
        bare.response_summary = None;
        let json2 = serde_json::to_string(&bare).unwrap();
        assert!(!json2.contains("requestSummary"), "None summary omitted");
        assert!(!json2.contains("responseSummary"), "None summary omitted");
    }
}
