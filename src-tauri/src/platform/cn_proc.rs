// Linux Process Capture backend — the proc connector (`cn_proc`) over a raw
// netlink socket, plus the `/proc/<pid>` reads that turn each exec event into
// a `CaptureEvent`.
//
// This is the Linux analogue of the Windows ETW `imp` in `process_watch.rs`.
// `cn_proc` reports the PID/TGID of every process that `exec`s, but carries
// NEITHER the argv NOR the parent PID — those come from `/proc` (which races
// the captured process's lifetime; see the `/proc` read fns for the
// fault-tolerance rules). Phase 2 (eBPF) is deferred and would replace this
// with a race-free, argv-carrying source behind the same `spawn_listener`
// contract.
//
// Module split: the PARSERS here (`parse_proc_event`, `parse_stat_ppid`,
// `join_cmdline`, `clean_exe_path`) are PURE — they take bytes/strings and
// return values, hold no fd, and are exercised by unit tests on every Linux
// build. The socket/thread/`/proc` runtime lives in `spawn_listener` and is
// only reachable with `CAP_NET_ADMIN` (see `docs/process-capture.md`), so it
// is covered by an `#[ignore]`d privileged integration test rather than CI.
//
// Gated `#![cfg(target_os = "linux")]` at the module declaration in
// `platform/mod.rs`; everything here assumes a Linux kernel + `/proc`.

use std::io;
use std::mem::size_of;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::{AppHandle, Runtime};

use super::process_watch::{emit_capture, iso_now, CaptureEvent};
use crate::core::capture_filter::CaptureFilter;
use crate::core::scope_tracker::CaptureScope;

// ----------------------------------------------------------------------
// Kernel constants not exposed by `libc`. Values cited from the kernel
// UAPI headers; they are part of the stable ABI.
// ----------------------------------------------------------------------

/// `CN_IDX_PROC` from `linux/cn_proc.h` — the connector index of the proc
/// connector. Also the netlink multicast group to bind to.
const CN_IDX_PROC: u32 = 1;
/// `CN_VAL_PROC` from `linux/cn_proc.h` — the connector value of the proc
/// connector. Together with `CN_IDX_PROC` it identifies the `cb_id`.
const CN_VAL_PROC: u32 = 1;
/// `PROC_CN_MCAST_LISTEN` from `linux/cn_proc.h` — the control op that asks
/// the kernel to start sending the proc-event multicast stream.
const PROC_CN_MCAST_LISTEN: u32 = 1;
/// `PROC_EVENT_EXEC` from `linux/cn_proc.h` (`enum what`). An `execve`
/// produces a fresh command line worth capturing. FORK / UID / GID / etc.
/// are ignored.
const PROC_EVENT_EXEC: u32 = 0x0000_0002;

/// `PROC_EVENT_EXIT` from `linux/cn_proc.h` (`enum what`). A process exit:
/// not surfaced, but its PID is fed to the filter's `on_exit` so the scope
/// tree and `sh -c` wrapper state are pruned (bounds PID reuse). See the
/// scoping plan §3.1.
const PROC_EVENT_EXIT: u32 = 0x8000_0000;

/// `NLMSG_ERROR` from `linux/netlink.h` — the `nlmsghdr.type` the kernel
/// returns to acknowledge or reject a request. The body is `struct nlmsgerr`
/// whose first field is a signed `error`: `0` = success ack, a negative
/// `-errno` = rejection. We read this right after sending the LISTEN op so a
/// sandbox that rejects the multicast subscription (Flatpak/Snap) surfaces a
/// real error at `start` instead of a silently-dead capture session.
const NLMSG_ERROR: u16 = 0x2;

// ----------------------------------------------------------------------
// Wire-layout offsets. Each datagram is `nlmsghdr` + `cn_msg` + `proc_event`,
// all fixed-layout C structs in host byte order. We do not depend on `libc`
// struct definitions for the parser (so it builds + tests on any target);
// instead we encode the offsets explicitly and validate them in tests.
// ----------------------------------------------------------------------

/// `struct nlmsghdr` is 16 bytes: `__u32 len`, `__u16 type`, `__u16 flags`,
/// `__u32 seq`, `__u32 pid`.
const NLMSGHDR_LEN: usize = 16;
/// Offset of `nlmsghdr.type` (a `__u16`) within the header — right after the
/// 4-byte `len`.
const NLMSGHDR_TYPE_OFF: usize = 4;
/// Offset of `nlmsgerr.error` (a signed `int`) — the `struct nlmsgerr` body
/// begins immediately after the `nlmsghdr`, and `error` is its first field.
const NLMSGERR_ERROR_OFF: usize = NLMSGHDR_LEN;

/// `struct cn_msg` header is 20 bytes: `cb_id { __u32 idx, __u32 val }` (8),
/// `__u32 seq`, `__u32 ack`, `__u16 len`, `__u16 flags` (12). `data[]`
/// (the `proc_event`) follows.
const CN_MSG_LEN: usize = 20;
/// Offset of `cb_id.idx` within `cn_msg` (== start of `cn_msg`).
const CN_MSG_IDX_OFF: usize = 0;
/// Offset of `cb_id.val` within `cn_msg`.
const CN_MSG_VAL_OFF: usize = 4;

/// `struct proc_event` prefix before the event-data union: `__u32 what`,
/// `__u32 cpu`, `__u64 timestamp_ns` = 16 bytes. The event variant of the
/// union then starts here.
const PROC_EVENT_HEADER_LEN: usize = 16;
/// Within `proc_event`, `what` is the first `__u32`.
const PROC_EVENT_WHAT_OFF: usize = 0;
/// The exec AND exit event bodies both begin with `__kernel_pid_t
/// process_pid` right after the 16-byte header, so this single offset serves
/// both (`struct exec_proc_event` / `struct exit_proc_event`).
const EVENT_PROCESS_PID_OFF: usize = PROC_EVENT_HEADER_LEN;
/// Bytes needed past the start of the `cn_msg` data to read `process_pid`.
const EVENT_PID_MIN_LEN: usize = EVENT_PROCESS_PID_OFF + size_of::<i32>();

/// Cap on the bytes we read from `/proc/<pid>/cmdline` to bound memory
/// against a pathological argv. Truncation is a display concern only.
const CMDLINE_READ_CAP: usize = 64 * 1024;

/// Read a little-endian `u32` at `off`, or `None` if out of bounds.
///
/// netlink/connector messages are in host byte order; ProcMix only targets
/// little-endian Linux hosts, so reading LE explicitly (rather than
/// `from_ne_bytes`) keeps the parser deterministic and test fixtures
/// portable across the dev host's endianness.
fn read_u32_le(buf: &[u8], off: usize) -> Option<u32> {
    let end = off.checked_add(4)?;
    let bytes = buf.get(off..end)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// Read a little-endian `i32` at `off`, or `None` if out of bounds.
fn read_i32_le(buf: &[u8], off: usize) -> Option<i32> {
    read_u32_le(buf, off).map(|v| v as i32)
}

/// Read a little-endian `u16` at `off`, or `None` if out of bounds.
fn read_u16_le(buf: &[u8], off: usize) -> Option<u16> {
    let end = off.checked_add(2)?;
    let bytes = buf.get(off..end)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// A proc-connector event we care about. The connector reports many event
/// types; we only act on two: an `exec` (surface a new command) and an
/// `exit` (prune the captured PID from the scope tree). FORK / UID / GID /
/// COMM / etc. are ignored.
#[derive(Debug, PartialEq, Eq)]
enum ProcEvent {
    /// `PROC_EVENT_EXEC`: the given PID called `execve`.
    Exec(u32),
    /// `PROC_EVENT_EXIT`: the given PID exited.
    Exit(u32),
}

/// Parse one received netlink datagram into a [`ProcEvent`], or `None` if it
/// is not an exec/exit we act on (or is malformed).
///
/// Returns `None` (caller skips, never panics) for ANY of: too-short buffer,
/// a `nlmsg_len` that lies about the payload size, a connector id that is not
/// `{ CN_IDX_PROC, CN_VAL_PROC }`, an event type other than exec/exit, or a
/// non-positive PID. This is the defensive guarantee that mirrors the Windows
/// `parse_process_start` returning `None` on any schema/PID failure.
///
/// Both exec and exit carry the PID as the FIRST field of their event body
/// (`process_pid`), at the same offset — so one validated read serves both.
/// argv, the parent PID, and the image path are NOT in the connector message
/// and are read from `/proc` by the caller.
fn parse_proc_event(buf: &[u8]) -> Option<ProcEvent> {
    let cn_msg_start = NLMSGHDR_LEN;
    let cn_data_start = cn_msg_start + CN_MSG_LEN;

    // Guard 1: the buffer must hold both fixed headers plus the event body's
    // leading `process_pid` (same minimum for exec and exit).
    if buf.len() < cn_data_start + EVENT_PID_MIN_LEN {
        return None;
    }

    // Guard 2: `nlmsg_len` (first u32) must not claim more bytes than we
    // actually received — a lying length must not let later reads run past
    // the real data.
    let nlmsg_len = read_u32_le(buf, 0)? as usize;
    if nlmsg_len > buf.len() || nlmsg_len < cn_data_start + EVENT_PID_MIN_LEN {
        return None;
    }

    // Guard 3: connector id must be the proc connector. Defends against any
    // stray traffic delivered on the socket.
    let idx = read_u32_le(buf, cn_msg_start + CN_MSG_IDX_OFF)?;
    let val = read_u32_le(buf, cn_msg_start + CN_MSG_VAL_OFF)?;
    if idx != CN_IDX_PROC || val != CN_VAL_PROC {
        return None;
    }

    // Guard 4: event type must be one we act on.
    let what = read_u32_le(buf, cn_data_start + PROC_EVENT_WHAT_OFF)?;
    if what != PROC_EVENT_EXEC && what != PROC_EVENT_EXIT {
        return None;
    }

    // The PID is the first event-body field for both exec and exit.
    // `__kernel_pid_t` is signed; a non-positive PID is malformed.
    let pid = read_i32_le(buf, cn_data_start + EVENT_PROCESS_PID_OFF)?;
    if pid <= 0 {
        return None;
    }
    let pid = pid as u32;
    match what {
        PROC_EVENT_EXEC => Some(ProcEvent::Exec(pid)),
        _ => Some(ProcEvent::Exit(pid)),
    }
}

/// Outcome of inspecting a datagram received right after the LISTEN request.
///
/// The kernel replies to a netlink request with an `NLMSG_ERROR` message
/// whose `error` field is `0` for a success ack or a negative `-errno` for a
/// rejection. A sandbox (Flatpak/Snap) that blocks the proc-connector
/// multicast typically rejects here, which we must turn into a real `start`
/// failure rather than a silently-dead session.
#[derive(Debug, PartialEq, Eq)]
enum ListenReply {
    /// `NLMSG_ERROR` with `error == 0`: the LISTEN was accepted.
    Ack,
    /// `NLMSG_ERROR` with `error != 0`: the kernel/sandbox rejected the
    /// request. Carries the positive `errno` (the wire value is `-errno`).
    Rejected(i32),
    /// Not an `NLMSG_ERROR` message — e.g. a real connector event that raced
    /// into the same window. Treated as "the channel is live" by the caller.
    NotAnError,
}

/// Classify a datagram received immediately after sending `PROC_CN_MCAST_LISTEN`.
///
/// Returns `None` only for a buffer too short to even hold the header — the
/// caller treats that the same as "no reply". Otherwise reports whether the
/// message is the kernel's `NLMSG_ERROR` ack/rejection (with the `errno`) or
/// some other (non-error) message. PURE: no socket, fully unit-testable on
/// byte fixtures.
fn parse_nlmsg_error(buf: &[u8]) -> Option<ListenReply> {
    // Must at least hold the netlink header to read `type`.
    if buf.len() < NLMSGHDR_LEN {
        return None;
    }
    let msg_type = read_u16_le(buf, NLMSGHDR_TYPE_OFF)?;
    if msg_type != NLMSG_ERROR {
        return Some(ListenReply::NotAnError);
    }
    // An `NLMSG_ERROR` body must carry the `error` int. If it is truncated,
    // be conservative and treat it as a non-error (don't fail `start` on a
    // malformed reply).
    let Some(error) = read_i32_le(buf, NLMSGERR_ERROR_OFF) else {
        return Some(ListenReply::NotAnError);
    };
    if error == 0 {
        Some(ListenReply::Ack)
    } else {
        // Wire value is `-errno`; report the positive errno. `saturating_neg`
        // guards the (impossible-in-practice) `i32::MIN` case.
        Some(ListenReply::Rejected(error.saturating_neg()))
    }
}

/// Reconstruct a human-readable command line from the raw bytes of
/// `/proc/<pid>/cmdline` (NUL-separated argv, usually with a trailing NUL).
///
/// Returns `None` for an empty/all-NUL file (kernel threads, zombies, or a
/// process that exited before we read) so the caller can fall back to the
/// image path / `comm`. argv tokens are joined with a single space and kept
/// VERBATIM — no shell-escaping — because `CaptureEvent.command_line` is
/// documented as "exactly as reported by the OS" and the frontend owns
/// redaction + display.
fn join_cmdline(raw: &[u8]) -> Option<String> {
    // Bound memory against a pathological argv. Truncation is display-only.
    let slice = if raw.len() > CMDLINE_READ_CAP {
        &raw[..CMDLINE_READ_CAP]
    } else {
        raw
    };

    let joined = slice
        .split(|&b| b == 0)
        .filter(|tok| !tok.is_empty())
        .map(|tok| String::from_utf8_lossy(tok))
        .collect::<Vec<_>>()
        .join(" ");

    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Parse the parent PID (field 4) from the raw contents of
/// `/proc/<pid>/stat`.
///
/// The `/proc/stat` parsing pitfall: the 2nd field, `comm`, is wrapped in
/// parentheses and MAY itself contain spaces and `)` (e.g. a process named
/// `(foo) bar`). Splitting on whitespace from the left is therefore wrong.
/// Correct approach: find the LAST `')'`, then the fields after it are
/// space-separated and fixed — `state` is the 1st, `ppid` the 2nd.
///
/// Returns `None` if the layout is unrecognisable; the caller then falls
/// back to `ppid = 0` (the parent is informational, never a reason to drop
/// an otherwise-good event).
fn parse_stat_ppid(stat: &str) -> Option<u32> {
    let rparen = stat.rfind(')')?;
    let rest = stat.get(rparen + 1..)?;
    // After the closing paren: " <state> <ppid> ...". Skip the state token,
    // take the ppid token.
    let mut fields = rest.split_whitespace();
    let _state = fields.next()?;
    let ppid = fields.next()?;
    ppid.parse::<u32>().ok()
}

/// Clean an executable path read via `readlink("/proc/<pid>/exe")`.
///
/// A binary that was replaced or unlinked after `exec` yields a path with a
/// trailing `" (deleted)"` marker from the kernel; strip it so the image
/// path stays a clean filesystem path for the UI and the noise filter.
fn clean_exe_path(path: &str) -> String {
    path.strip_suffix(" (deleted)").unwrap_or(path).to_string()
}

// ----------------------------------------------------------------------
// Runtime: socket setup, listener thread, and the `/proc` reads that turn a
// captured PID into a `CaptureEvent`. Only reachable on a real Linux host;
// not covered by CI unit tests (it needs `CAP_NET_ADMIN`), but the
// pure parsers above are.
// ----------------------------------------------------------------------

/// libc constants for the proc-connector multicast group. Mirrors the
/// `socket(2)` / `bind(2)` setup described in the design doc.
const SOL_NETLINK_CONNECTOR: libc::c_int = libc::NETLINK_CONNECTOR;

/// How long [`check_listen_reply`] waits for the kernel's `NLMSG_ERROR`
/// ack/rejection after sending the LISTEN op. The reply is local (the kernel
/// answers on the same socket, not over a network), so it is effectively
/// immediate; 200 ms is a generous upper bound that only ever elapses when
/// the kernel stays silent (treated as healthy — see the function doc).
const LISTEN_REPLY_TIMEOUT_MS: libc::c_int = 200;

/// Why starting the cn_proc listener failed. Distinguishes the
/// privilege case (so the UI can guide the user toward `CAP_NET_ADMIN`)
/// from a generic OS error. The `Display` strings are surfaced to the
/// frontend via `imp::start`.
pub(super) enum StartError {
    /// `bind`/`send` returned `EPERM`/`EACCES` — the proc connector
    /// multicast bind needs `CAP_NET_ADMIN`.
    Privilege,
    /// Any other failure during socket setup or thread spawn.
    Other(String),
}

impl StartError {
    fn from_io(context: &str, err: &io::Error) -> Self {
        match err.raw_os_error() {
            Some(code) if code == libc::EPERM || code == libc::EACCES => StartError::Privilege,
            _ => StartError::Other(format!("{context}: {err}")),
        }
    }
}

/// A running cn_proc capture session. Owns the worker thread, the atomic
/// stop flag, and the write end of the self-pipe used to wake the blocked
/// `poll()`/`recv()` so the thread exits promptly on stop.
pub(super) struct Listener {
    running: Arc<AtomicBool>,
    /// Write end of the self-pipe. Writing one byte wakes the worker's
    /// `poll()` so it observes `running == false` and returns.
    wake_write: OwnedFd,
    thread: Option<JoinHandle<()>>,
}

/// Begin a cn_proc capture session: open + bind the netlink connector
/// socket, request the multicast stream, and spawn the blocking listener
/// thread. The thread owns the socket fd and the read end of the self-pipe.
///
/// `self_exe` keys the noise filter for self-exclusion (mirrors the Windows
/// path). `scope` constrains capture to a process subtree; for the subtree
/// variants the current process tree is snapshotted from `/proc` and seeded
/// so already-running descendants are recognised (scoping plan §3.3). The
/// snapshot is taken AFTER the socket is subscribed so a child born during
/// the gap still arrives as a live event. On failure no thread is spawned and
/// all fds are closed.
pub(super) fn start<R: Runtime>(
    app: AppHandle<R>,
    self_exe: String,
    scope: CaptureScope,
) -> Result<Listener, StartError> {
    // The connector socket. `SOCK_CLOEXEC` so a child we capture cannot
    // inherit it. Subscribed (LISTEN sent) before we snapshot.
    let sock = open_connector_socket()?;

    // Self-pipe for clean shutdown: the worker `poll()`s on BOTH the socket
    // and the pipe's read end; `stop` writes one byte to `wake_write` to
    // unblock it. `pipe2(O_CLOEXEC)` for the same inheritance reason.
    let (wake_read, wake_write) = make_wake_pipe()
        .map_err(|e| StartError::Other(format!("failed to create capture self-pipe: {e}")))?;

    let running = Arc::new(AtomicBool::new(true));
    let running_for_thread = running.clone();

    // The filter needs `&mut` but lives across the loop; one worker thread
    // means the `Mutex` is never contended (parallels the Windows impl).
    //
    // Mandatory self-exclusion (scoping plan §3.4): never record ProcMix's own
    // subtree OR its immediate parent's (the launcher / terminal / agent that
    // started ProcMix) — recording those is a privacy leak. Roots = our PID +
    // our parent PID (best-effort; a failed ppid read just narrows the tree).
    let self_roots = self_exclude_roots();
    let mut capture_filter =
        CaptureFilter::with_scope_and_self_subtree(&self_exe, scope, self_roots);
    // Seed already-running descendants of the scoped root(s) from a `/proc`
    // snapshot — but only when the scope actually needs it (skip the walk for
    // `All`). Taken AFTER the socket subscribed so a child born in the gap
    // still arrives as a live event.
    if capture_filter.needs_seeding() {
        capture_filter.seed_scope(&read_proc_tree_snapshot());
    }
    let filter = Mutex::new(capture_filter);

    // Move ownership of the socket + pipe-read fd into the thread; it closes
    // them on exit.
    let sock_fd = sock;
    let wake_read_fd = wake_read;

    let thread = std::thread::Builder::new()
        .name("procmix-capture".into())
        .spawn(move || {
            listener_loop(app, sock_fd, wake_read_fd, running_for_thread, filter);
        })
        .map_err(|e| StartError::Other(format!("failed to spawn capture thread: {e}")))?;

    Ok(Listener {
        running,
        wake_write,
        thread: Some(thread),
    })
}

/// Stop a running session: flip the atomic, wake the blocked `poll()` via
/// the self-pipe, and join the worker thread. Idempotent at the call site
/// (the owner ensures it is called at most once per `Listener`).
pub(super) fn stop(mut listener: Listener) {
    listener.running.store(false, Ordering::Relaxed);
    // Write one byte to wake the worker's `poll()`. Best-effort: if the
    // write fails the worker still exits on the next `poll()` timeout.
    let byte = [1u8];
    // SAFETY: `wake_write` is a valid, owned fd for the lifetime of this
    // call; `write(2)` with a 1-byte buffer cannot read out of bounds.
    unsafe {
        libc::write(listener.wake_write.as_raw_fd(), byte.as_ptr().cast(), 1);
    }
    if let Some(thread) = listener.thread.take() {
        let _ = thread.join();
    }
    // `wake_write` (and, inside the thread, the socket + read end) drop and
    // close here.
}

/// Open and bind the netlink proc-connector socket, then request the
/// multicast event stream. Returns the owned socket fd on success.
fn open_connector_socket() -> Result<OwnedFd, StartError> {
    // SAFETY: `socket(2)` with constant, valid arguments. The returned fd is
    // immediately wrapped in `OwnedFd` so it is closed on any early return.
    let raw = unsafe {
        libc::socket(
            libc::AF_NETLINK,
            libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
            SOL_NETLINK_CONNECTOR,
        )
    };
    if raw < 0 {
        return Err(StartError::from_io(
            "failed to open netlink connector socket",
            &io::Error::last_os_error(),
        ));
    }
    // SAFETY: `raw` is a fresh, valid fd owned by us (checked >= 0 above).
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };

    // Bind to the proc-connector multicast group so the kernel delivers
    // proc events to us. `nl_pid = 0` lets the kernel assign a unique port.
    let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
    addr.nl_groups = CN_IDX_PROC;
    // SAFETY: `addr` is a fully-initialised `sockaddr_nl`; we pass its real
    // size. `fd` is valid for the duration of the call.
    let rc = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_nl).cast(),
            size_of::<libc::sockaddr_nl>() as libc::socklen_t,
        )
    };
    if rc < 0 {
        return Err(StartError::from_io(
            "failed to bind netlink connector socket (needs CAP_NET_ADMIN)",
            &io::Error::last_os_error(),
        ));
    }

    send_listen_request(&fd)?;
    Ok(fd)
}

/// Send the `PROC_CN_MCAST_LISTEN` control message that tells the kernel to
/// start streaming proc events. Layout: `nlmsghdr` + `cn_msg` + a single
/// `u32` op (`PROC_CN_MCAST_LISTEN`).
fn send_listen_request(fd: &OwnedFd) -> Result<(), StartError> {
    // Body op is one u32.
    let op_len = size_of::<u32>();
    let cn_payload_len = CN_MSG_LEN + op_len;
    let total = NLMSGHDR_LEN + cn_payload_len;
    let mut msg = vec![0u8; total];

    // nlmsghdr.len = total.
    msg[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    // nlmsghdr.type = NLMSG_DONE (3) — what the kernel expects for a
    // connector control message.
    msg[4..6].copy_from_slice(&(libc::NLMSG_DONE as u16).to_le_bytes());
    // type/flags/seq/pid left zero.

    // cn_msg: cb_id { idx = CN_IDX_PROC, val = CN_VAL_PROC }.
    let cn = NLMSGHDR_LEN;
    msg[cn..cn + 4].copy_from_slice(&CN_IDX_PROC.to_le_bytes());
    msg[cn + 4..cn + 8].copy_from_slice(&CN_VAL_PROC.to_le_bytes());
    // seq (8..12), ack (12..16) left zero.
    // cn_msg.len = length of the data that follows (the op u32).
    msg[cn + 16..cn + 18].copy_from_slice(&(op_len as u16).to_le_bytes());
    // flags (18..20) left zero.

    // data: the listen op.
    let data = cn + CN_MSG_LEN;
    msg[data..data + 4].copy_from_slice(&PROC_CN_MCAST_LISTEN.to_le_bytes());

    // SAFETY: `msg` is a valid, fully-initialised buffer of length `total`;
    // we pass that exact length. `fd` is a valid socket fd.
    let sent = unsafe { libc::send(fd.as_raw_fd(), msg.as_ptr().cast(), msg.len(), 0) };
    if sent < 0 {
        return Err(StartError::from_io(
            "failed to send PROC_CN_MCAST_LISTEN",
            &io::Error::last_os_error(),
        ));
    }

    // Synchronously check the kernel's reply. A sandbox (Flatpak/Snap) that
    // blocks the proc-connector multicast usually rejects the LISTEN with an
    // `NLMSG_ERROR` carrying `-errno`; without this check `start` would
    // return `Ok` and the capture session would be silently dead.
    check_listen_reply(fd)
}

/// Bounded read of the kernel's reply to the LISTEN request.
///
/// Polls the socket for up to [`LISTEN_REPLY_TIMEOUT_MS`]. If an
/// `NLMSG_ERROR` rejection arrives, it is mapped through [`StartError::from_io`]
/// (so `EPERM`/`EACCES` becomes `Privilege`). An ack, a non-error message
/// (a real event that raced in), or SILENCE are all treated as success:
/// the kernel does not guarantee an ack on a healthy system, so we
/// deliberately do NOT fail `start` on a timeout — only on an explicit
/// rejection. This keeps the check free of false negatives that would hide
/// the feature on a quiet but working host.
fn check_listen_reply(fd: &OwnedFd) -> Result<(), StartError> {
    let mut pfd = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: single, initialised `pollfd`; the timeout is a plain int.
    let rc = unsafe { libc::poll(&mut pfd, 1, LISTEN_REPLY_TIMEOUT_MS) };
    if rc <= 0 {
        // 0 = timeout (silence → assume healthy, see doc comment); <0 = poll
        // error, which we also do not treat as a privilege problem here —
        // the listener loop will surface any genuine socket failure.
        return Ok(());
    }
    if pfd.revents & libc::POLLIN == 0 {
        return Ok(());
    }

    let mut buf = [0u8; 256];
    // SAFETY: `buf` is a valid writable buffer of `buf.len()` bytes; `recv`
    // writes at most that many. `MSG_DONTWAIT` so we never block even if the
    // readiness was spurious.
    let n = unsafe {
        libc::recv(
            fd.as_raw_fd(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            libc::MSG_DONTWAIT,
        )
    };
    if n <= 0 {
        return Ok(());
    }

    match parse_nlmsg_error(&buf[..n as usize]) {
        Some(ListenReply::Rejected(errno)) => Err(StartError::from_io(
            "kernel rejected PROC_CN_MCAST_LISTEN",
            &io::Error::from_raw_os_error(errno),
        )),
        // Ack, a raced-in event, a malformed/short reply, or no error message
        // all mean the subscription is (as far as we can tell) live.
        _ => Ok(()),
    }
}

/// Create a `pipe2(O_CLOEXEC)` self-pipe, returning `(read, write)` owned
/// fds. The write end wakes the worker's `poll()`; the read end is what the
/// worker polls.
fn make_wake_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` is a 2-element array as required by `pipe2`.
    let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both fds are fresh and valid (rc == 0).
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((read, write))
}

/// The blocking listener loop. Owns the socket + the wake pipe's read end;
/// both close when this returns. `poll()`s on both fds so a `stop` (which
/// writes to the wake pipe) returns promptly without waiting for the next
/// event.
fn listener_loop<R: Runtime>(
    app: AppHandle<R>,
    sock: OwnedFd,
    wake_read: OwnedFd,
    running: Arc<AtomicBool>,
    filter: Mutex<CaptureFilter>,
) {
    // Recv buffer: connector datagrams are small; 8 KiB is generous.
    let mut buf = [0u8; 8192];

    while running.load(Ordering::Relaxed) {
        let mut pfds = [
            libc::pollfd {
                fd: sock.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wake_read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];

        // SAFETY: `pfds` is a 2-element array of initialised `pollfd`. A
        // -1 timeout blocks until an fd is ready or a signal arrives.
        let rc = unsafe { libc::poll(pfds.as_mut_ptr(), 2, -1) };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue; // EINTR: re-poll.
            }
            // Any other poll error: stop the loop rather than spin.
            break;
        }

        // Wake pipe signalled → shutdown requested.
        if pfds[1].revents & libc::POLLIN != 0 {
            break;
        }

        if pfds[0].revents & libc::POLLIN == 0 {
            continue;
        }

        // SAFETY: `buf` is a valid, writable buffer of `buf.len()` bytes;
        // `recv` writes at most that many. `sock` is a valid socket fd.
        let n = unsafe { libc::recv(sock.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
        if n <= 0 {
            // 0 = orderly shutdown; <0 = error. EINTR re-loops; otherwise
            // stop. We re-check `running` at the top either way.
            if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if n < 0 {
                break;
            }
            continue;
        }

        let received = &buf[..n as usize];
        match parse_proc_event(received) {
            Some(ProcEvent::Exit(pid)) => {
                // Prune the dead PID from the filter's scope tree / wrapper
                // state. Never surfaced. Cheap, so we don't re-check `running`.
                if let Ok(mut f) = filter.lock() {
                    f.on_exit(pid);
                }
            }
            Some(ProcEvent::Exec(pid)) => {
                // Re-check the stop flag before doing `/proc` work for an
                // event that arrived right as we were stopping.
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(event) = build_capture_event(pid) {
                    let keep = filter
                        .lock()
                        .map(|mut f| {
                            f.should_emit(event.pid, event.ppid, &event.image, &event.command_line)
                        })
                        .unwrap_or(true);
                    if keep {
                        emit_capture(&app, &event);
                    }
                }
            }
            None => continue,
        }
    }
}

/// Assemble a [`CaptureEvent`] for an exec'd PID from `/proc`. Returns
/// `None` only when BOTH the command line and the image are unavailable
/// (the process exited before we could read it — the known accuracy limit
/// of the cn_proc + `/proc` approach); such a pid-only row is useless to
/// the user, so it is dropped.
///
/// Read order is `cmdline` (the payload) → `exe` → `stat`, each
/// independently fault-tolerant.
fn build_capture_event(pid: u32) -> Option<CaptureEvent> {
    let cmdline = read_cmdline(pid);
    let image = read_image(pid, cmdline.as_deref());

    // Drop only if we have neither a command line nor an image.
    let command_line = match (cmdline, image.is_empty()) {
        (Some(c), _) => c,
        // No cmdline but we do have an image → use the image as the command.
        (None, false) => image.clone(),
        // Neither → nothing worth showing.
        (None, true) => return None,
    };

    let ppid = read_ppid(pid).unwrap_or(0);

    Some(CaptureEvent {
        pid,
        ppid,
        image,
        command_line,
        timestamp: iso_now(),
    })
}

/// Read + join `/proc/<pid>/cmdline`. `None` if empty/unreadable (race).
fn read_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    join_cmdline(&raw)
}

/// Resolve the executable image path. Tries `readlink(/proc/<pid>/exe)`
/// first; on a race/permission failure falls back to argv[0] from the
/// command line, then `/proc/<pid>/comm`, then the empty string.
fn read_image(pid: u32, command_line: Option<&str>) -> String {
    if let Ok(target) = std::fs::read_link(format!("/proc/{pid}/exe")) {
        let path = target.to_string_lossy();
        let cleaned = clean_exe_path(&path);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    // Fallback 1: argv[0].
    if let Some(cmd) = command_line {
        if let Some(arg0) = cmd.split_whitespace().next() {
            if !arg0.is_empty() {
                return arg0.to_string();
            }
        }
    }
    // Fallback 2: `comm` (the binary's short name).
    if let Some(comm) = read_comm(pid) {
        return comm;
    }
    String::new()
}

/// Read the parent PID from `/proc/<pid>/stat`. `None` on a read failure
/// (race) so the caller defaults to `0`.
fn read_ppid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat_ppid(&stat)
}

/// Roots of ProcMix's own subtree to exclude from capture (scoping plan §3.4):
/// our own PID plus our immediate parent (the launcher / terminal / agent that
/// started ProcMix). Best-effort — if the parent can't be read, only our own
/// PID is excluded. The `0` placeholder ppid is never added as a root.
fn self_exclude_roots() -> std::collections::HashSet<u32> {
    let mut roots = std::collections::HashSet::new();
    let me = std::process::id();
    roots.insert(me);
    if let Some(ppid) = read_ppid(me) {
        if ppid != 0 {
            roots.insert(ppid);
        }
    }
    roots
}

/// Snapshot the current process tree as `(pid, ppid)` pairs by walking
/// `/proc/<pid>/stat` for every numeric `/proc` entry. Used to seed the
/// scope tracker with already-running descendants of a scoped root before
/// recording began (scoping plan §3.3). Best-effort: an entry that races
/// away (`ENOENT`) or a non-numeric dir is simply skipped, so a partial
/// snapshot never fails `start`.
fn read_proc_tree_snapshot() -> Vec<(u32, u32)> {
    let mut pairs = Vec::new();
    for_each_proc_pid(|pid| {
        if let Some(ppid) = read_ppid(pid) {
            pairs.push((pid, ppid));
        }
    });
    pairs
}

/// Call `f(pid)` for every numeric `/proc/<pid>` entry. Shared by the
/// tree-snapshot (seeding) and the capture-target enumeration so the `/proc`
/// directory walk + numeric-name filter live in one place. Best-effort: if
/// `/proc` can't be read, `f` is simply never called.
fn for_each_proc_pid(mut f: impl FnMut(u32)) {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        // Only numeric directories are PIDs.
        if let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        {
            f(pid);
        }
    }
}

/// Enumerate processes the user can scope capture to, as `(pid, name)`.
/// First version: ALL processes (window-based filtering deferred — scoping
/// plan §4.1). Skips entries with no resolvable name (kernel threads, or that
/// raced away). Sorted by name for a stable list.
pub(super) fn list_targets() -> Vec<super::process_watch::CaptureTarget> {
    let mut targets = Vec::new();
    for_each_proc_pid(|pid| {
        if let Some(name) = read_target_name(pid) {
            targets.push(super::process_watch::CaptureTarget { pid, name });
        }
    });
    targets.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    targets
}

/// A display name for a process in the target picker, in order of preference:
///
/// 1. **`readlink(/proc/<pid>/exe)`** basename — the real binary name, but
///    often denied (`EACCES`) for processes owned by another user without
///    `CAP_SYS_PTRACE`.
/// 2. **`/proc/<pid>/cmdline` argv[0]** basename — world-readable (works for
///    other users' processes) and carries the FULL name, e.g. a root daemon
///    whose `comm` is `openvpn3-servic` (truncated) but whose argv[0] is
///    `/usr/libexec/.../openvpn3-service-log`.
/// 3. **`/proc/<pid>/comm`** — always readable but the kernel truncates it to
///    15 chars (`TASK_COMM_LEN`), so it is the LAST resort.
///
/// `None` only if all three are unavailable (kernel thread that raced away).
fn read_target_name(pid: u32) -> Option<String> {
    read_exe_basename(pid)
        .or_else(|| read_cmdline_basename(pid))
        .or_else(|| read_comm(pid))
}

/// Basename of `readlink(/proc/<pid>/exe)`, with the kernel's trailing
/// `" (deleted)"` marker stripped. `None` if the link is unreadable (race /
/// permission / kernel thread) or resolves to an empty name.
fn read_exe_basename(pid: u32) -> Option<String> {
    let target = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let path = target.to_string_lossy();
    let cleaned = clean_exe_path(&path);
    let base = cleaned.rsplit('/').next().unwrap_or(&cleaned).trim();
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// Basename of argv[0] from `/proc/<pid>/cmdline`. Unlike `/proc/<pid>/exe`,
/// `cmdline` is world-readable, so this resolves a full name even for another
/// user's process. `None` if the file is empty (kernel threads / zombies).
fn read_cmdline_basename(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    argv0_basename(&raw)
}

/// Pure: extract the basename of argv[0] from raw `/proc/<pid>/cmdline` bytes
/// (NUL-separated argv). Takes the first NUL-delimited token, strips any
/// directory path, and returns its basename. `None` for empty/whitespace
/// argv[0]. Tested on byte fixtures.
fn argv0_basename(raw: &[u8]) -> Option<String> {
    let first = raw.split(|&b| b == 0).next()?;
    if first.is_empty() {
        return None;
    }
    let argv0 = String::from_utf8_lossy(first);
    let base = argv0.rsplit('/').next().unwrap_or(&argv0).trim();
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// Read `/proc/<pid>/comm` (the process's short name). `None` if unreadable
/// (race) or empty.
fn read_comm(pid: u32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let trimmed = comm.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid datagram: 16-byte nlmsghdr + 20-byte cn_msg +
    /// proc_event (16-byte header + exec body). `what` and `pid` are
    /// parameterised so tests can flip individual fields.
    fn build_message(
        nlmsg_len_override: Option<u32>,
        idx: u32,
        val: u32,
        what: u32,
        pid: i32,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        // nlmsghdr: len (filled below), type, flags, seq, pid.
        let total_len = (NLMSGHDR_LEN + CN_MSG_LEN + PROC_EVENT_HEADER_LEN + 8) as u32;
        buf.extend_from_slice(&nlmsg_len_override.unwrap_or(total_len).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // type
        buf.extend_from_slice(&0u16.to_le_bytes()); // flags
        buf.extend_from_slice(&0u32.to_le_bytes()); // seq
        buf.extend_from_slice(&0u32.to_le_bytes()); // pid
        debug_assert_eq!(buf.len(), NLMSGHDR_LEN);

        // cn_msg: cb_id { idx, val }, seq, ack, len, flags.
        buf.extend_from_slice(&idx.to_le_bytes());
        buf.extend_from_slice(&val.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // seq
        buf.extend_from_slice(&0u32.to_le_bytes()); // ack
        buf.extend_from_slice(&0u16.to_le_bytes()); // len
        buf.extend_from_slice(&0u16.to_le_bytes()); // flags
        debug_assert_eq!(buf.len(), NLMSGHDR_LEN + CN_MSG_LEN);

        // proc_event: what, cpu, timestamp_ns, then the event body whose
        // first field is `process_pid` (same layout for exec and exit).
        buf.extend_from_slice(&what.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // cpu
        buf.extend_from_slice(&0u64.to_le_bytes()); // timestamp_ns
        buf.extend_from_slice(&pid.to_le_bytes()); // process_pid
        buf.extend_from_slice(&pid.to_le_bytes()); // process_tgid
        buf
    }

    #[test]
    fn parses_a_valid_exec_event() {
        let buf = build_message(None, CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXEC, 4321);
        assert_eq!(parse_proc_event(&buf), Some(ProcEvent::Exec(4321)));
    }

    #[test]
    fn parses_a_valid_exit_event() {
        let buf = build_message(None, CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXIT, 4321);
        assert_eq!(parse_proc_event(&buf), Some(ProcEvent::Exit(4321)));
    }

    #[test]
    fn ignores_event_types_we_do_not_act_on() {
        // PROC_EVENT_FORK (0x1), UID (0x4), etc. are neither exec nor exit.
        let fork = build_message(None, CN_IDX_PROC, CN_VAL_PROC, 0x0000_0001, 10);
        assert_eq!(parse_proc_event(&fork), None);
        let uid = build_message(None, CN_IDX_PROC, CN_VAL_PROC, 0x0000_0004, 10);
        assert_eq!(parse_proc_event(&uid), None);
    }

    #[test]
    fn rejects_wrong_connector_id() {
        let bad_idx = build_message(None, 99, CN_VAL_PROC, PROC_EVENT_EXEC, 10);
        assert_eq!(parse_proc_event(&bad_idx), None);
        let bad_val = build_message(None, CN_IDX_PROC, 99, PROC_EVENT_EXEC, 10);
        assert_eq!(parse_proc_event(&bad_val), None);
    }

    #[test]
    fn rejects_truncated_buffer() {
        let buf = build_message(None, CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXEC, 10);
        // Lop off the last few bytes so the exec body is incomplete.
        let truncated = &buf[..buf.len() - 4];
        assert_eq!(parse_proc_event(truncated), None);
        // An empty buffer must not panic either.
        assert_eq!(parse_proc_event(&[]), None);
    }

    #[test]
    fn rejects_lying_length_field() {
        // nlmsg_len claims far more than the buffer holds.
        let buf = build_message(Some(9999), CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXEC, 10);
        assert_eq!(parse_proc_event(&buf), None);
    }

    #[test]
    fn rejects_nonpositive_pid() {
        let zero = build_message(None, CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXEC, 0);
        assert_eq!(parse_proc_event(&zero), None);
        let neg = build_message(None, CN_IDX_PROC, CN_VAL_PROC, PROC_EVENT_EXEC, -1);
        assert_eq!(parse_proc_event(&neg), None);
    }

    // ------------------------------------------------------------------
    // `parse_nlmsg_error` (Approach A): the synchronous LISTEN-reply check.
    // The kernel answers a netlink request with an `NLMSG_ERROR` message
    // (`error == 0` ack, `-errno` rejection). A sandbox that blocks the
    // proc-connector multicast rejects here, which must surface as a real
    // `start` failure. PURE byte-fixture tests, no socket.
    // ------------------------------------------------------------------

    /// Build a 16-byte `nlmsghdr` with the given `type`, followed by `body`.
    fn build_nlmsg(msg_type: u16, body: &[u8]) -> Vec<u8> {
        let total = (NLMSGHDR_LEN + body.len()) as u32;
        let mut buf = Vec::new();
        buf.extend_from_slice(&total.to_le_bytes()); // len
        buf.extend_from_slice(&msg_type.to_le_bytes()); // type
        buf.extend_from_slice(&0u16.to_le_bytes()); // flags
        buf.extend_from_slice(&0u32.to_le_bytes()); // seq
        buf.extend_from_slice(&0u32.to_le_bytes()); // pid
        buf.extend_from_slice(body);
        buf
    }

    /// An `NLMSG_ERROR` body: a signed `error` int (`-errno`), then an echoed
    /// `nlmsghdr` of the offending request (content irrelevant to the parser).
    fn build_nlmsg_error(error: i32) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&error.to_le_bytes());
        body.extend_from_slice(&[0u8; NLMSGHDR_LEN]); // echoed request header
        build_nlmsg(NLMSG_ERROR, &body)
    }

    #[test]
    fn nlmsg_error_with_zero_is_ack() {
        let buf = build_nlmsg_error(0);
        assert_eq!(parse_nlmsg_error(&buf), Some(ListenReply::Ack));
    }

    #[test]
    fn nlmsg_error_with_negative_errno_is_rejection() {
        // Wire value is `-errno`; the parser reports the positive errno.
        let eperm = build_nlmsg_error(-libc::EPERM);
        assert_eq!(
            parse_nlmsg_error(&eperm),
            Some(ListenReply::Rejected(libc::EPERM))
        );
        let eacces = build_nlmsg_error(-libc::EACCES);
        assert_eq!(
            parse_nlmsg_error(&eacces),
            Some(ListenReply::Rejected(libc::EACCES))
        );
    }

    #[test]
    fn non_error_message_is_not_an_error() {
        // A real connector event (NLMSG_DONE etc.) that raced into the reply
        // window means the channel is live, not rejected.
        let other = build_nlmsg(libc::NLMSG_DONE as u16, &[0u8; 32]);
        assert_eq!(parse_nlmsg_error(&other), Some(ListenReply::NotAnError));
    }

    #[test]
    fn truncated_error_body_is_treated_as_non_error() {
        // `NLMSG_ERROR` type but no room for the `error` int → conservative
        // NotAnError (do not fail `start` on a malformed reply).
        let mut buf = build_nlmsg(NLMSG_ERROR, &[]);
        buf.truncate(NLMSGHDR_LEN); // header only, no body
        assert_eq!(parse_nlmsg_error(&buf), Some(ListenReply::NotAnError));
    }

    #[test]
    fn buffer_too_short_for_header_yields_none() {
        assert_eq!(parse_nlmsg_error(&[]), None);
        assert_eq!(parse_nlmsg_error(&[0u8; NLMSGHDR_LEN - 1]), None);
    }

    #[test]
    fn joins_nul_separated_argv() {
        let raw = b"git\0status\0--short\0";
        assert_eq!(join_cmdline(raw).as_deref(), Some("git status --short"));
    }

    #[test]
    fn joins_cmdline_without_trailing_nul() {
        let raw = b"ls\0-la";
        assert_eq!(join_cmdline(raw).as_deref(), Some("ls -la"));
    }

    #[test]
    fn empty_cmdline_yields_none() {
        assert_eq!(join_cmdline(b""), None);
        assert_eq!(join_cmdline(b"\0\0\0"), None);
    }

    #[test]
    fn cmdline_preserves_embedded_spaces_verbatim() {
        // An argv token may itself contain spaces; we must NOT escape them.
        let raw = b"editor\0/path/with space/file.txt\0";
        assert_eq!(
            join_cmdline(raw).as_deref(),
            Some("editor /path/with space/file.txt")
        );
    }

    #[test]
    fn cmdline_read_is_capped() {
        // A pathological argv of one giant token is truncated to the cap.
        let mut raw = vec![b'a'; CMDLINE_READ_CAP * 2];
        // Ensure there is no NUL so it's a single token.
        raw.iter_mut().for_each(|b| *b = b'a');
        let joined = join_cmdline(&raw).expect("non-empty");
        assert_eq!(joined.len(), CMDLINE_READ_CAP);
    }

    #[test]
    fn parses_ppid_from_simple_stat() {
        // pid (comm) state ppid ...
        let stat = "4321 (bash) S 4000 4321 4321 34816 ...";
        assert_eq!(parse_stat_ppid(stat), Some(4000));
    }

    #[test]
    fn parses_ppid_with_parens_and_spaces_in_comm() {
        // The canonical pitfall: comm contains ')' AND spaces.
        let stat = "1234 ((weird) name) R 777 1234 0 0 ...";
        assert_eq!(parse_stat_ppid(stat), Some(777));
    }

    #[test]
    fn ppid_parse_handles_garbage() {
        assert_eq!(parse_stat_ppid(""), None);
        assert_eq!(parse_stat_ppid("no parens here"), None);
        // Closing paren but no fields after it.
        assert_eq!(parse_stat_ppid("1 (x)"), None);
    }

    #[test]
    fn strips_deleted_suffix_from_exe_path() {
        assert_eq!(
            clean_exe_path("/usr/bin/python3.11 (deleted)"),
            "/usr/bin/python3.11"
        );
        // A normal path is unchanged.
        assert_eq!(clean_exe_path("/usr/bin/git"), "/usr/bin/git");
        // " (deleted)" only stripped as a trailing suffix, not mid-path.
        assert_eq!(
            clean_exe_path("/opt/a (deleted)/bin/tool"),
            "/opt/a (deleted)/bin/tool"
        );
    }

    // The `/proc`-backed readers can be exercised WITHOUT `CAP_NET_ADMIN` by
    // pointing them at the test process's own PID — `/proc/self` is always
    // readable by the owning process. These cover the assembly path
    // (`build_capture_event` and its three readers) that the parser unit
    // tests above cannot reach.

    #[test]
    fn reads_image_for_self() {
        let pid = std::process::id();
        let image = read_image(pid, None);
        // The test binary's own exe must resolve to a non-empty absolute path.
        assert!(
            image.starts_with('/'),
            "expected an absolute exe path, got {image:?}"
        );
        assert!(
            !image.ends_with(" (deleted)"),
            "deleted marker must be stripped"
        );
    }

    #[test]
    fn reads_ppid_for_self() {
        let pid = std::process::id();
        // Our parent (the test harness / cargo) always exists, so ppid > 0.
        let ppid = read_ppid(pid).expect("self stat must parse");
        assert!(ppid > 0, "self ppid should be a real parent pid");
    }

    #[test]
    fn target_name_for_self_is_full_exe_basename() {
        let pid = std::process::id();
        // The test binary resolves its own `/proc/self/exe`, so the target
        // name is the FULL basename (not a 15-char-truncated `comm`).
        let name = read_target_name(pid).expect("self must have a name");
        assert!(!name.is_empty());
        assert!(!name.contains('/'), "name should be a basename, not a path");
        assert!(
            !name.ends_with(" (deleted)"),
            "the deleted marker must be stripped"
        );
        // It must match the exe basename exactly (exe is preferred over comm).
        let exe = read_exe_basename(pid).expect("self exe must resolve");
        assert_eq!(name, exe);
    }

    #[test]
    fn target_name_falls_back_through_chain_without_exe() {
        // PID 0 has no readable exe / cmdline / comm, so the name is
        // unresolvable — proves the fallback chain terminates in `None`
        // rather than panicking.
        assert!(read_exe_basename(0).is_none());
        assert!(read_cmdline_basename(0).is_none());
        assert!(read_target_name(0).is_none());
    }

    #[test]
    fn argv0_basename_extracts_full_name_from_cmdline() {
        // The real-world case: a root daemon whose `comm` is truncated to
        // `openvpn3-servic`, but whose argv[0] carries the full path.
        let raw = b"/usr/libexec/openvpn3-linux/openvpn3-service-log\0--state-dir\0/var/lib\0";
        assert_eq!(argv0_basename(raw).as_deref(), Some("openvpn3-service-log"));
    }

    #[test]
    fn argv0_basename_handles_bare_name_and_login_shell() {
        // argv[0] without a path is returned as-is.
        assert_eq!(
            argv0_basename(b"node\0server.js\0").as_deref(),
            Some("node")
        );
        // A login shell sets argv[0] to "-bash"; basename keeps it verbatim
        // (no leading-dash stripping — it is still informative).
        assert_eq!(argv0_basename(b"-bash\0").as_deref(), Some("-bash"));
    }

    #[test]
    fn argv0_basename_empty_or_pathless_edge_cases() {
        assert_eq!(argv0_basename(b""), None);
        assert_eq!(argv0_basename(b"\0\0"), None);
        // A trailing slash → empty basename → None (don't surface "").
        assert_eq!(argv0_basename(b"/usr/bin/\0"), None);
    }

    #[test]
    fn build_capture_event_for_self_is_complete() {
        let pid = std::process::id();
        let event = build_capture_event(pid).expect("self must produce an event");
        assert_eq!(event.pid, pid);
        // We must have at least one of image / command line (both, in fact,
        // for a live process reading its own `/proc`).
        assert!(
            !event.image.is_empty() || !event.command_line.is_empty(),
            "self event must carry image or command line"
        );
        assert!(!event.image.is_empty(), "self exe should resolve");
    }

    #[test]
    fn build_capture_event_drops_dead_pid() {
        // PID 0 never has a readable `/proc/0`, so both readers fail and the
        // event is dropped (the cn_proc + /proc race accuracy limit).
        assert!(build_capture_event(0).is_none());
    }

    // ------------------------------------------------------------------
    // `StartError` classification (Layer 1). The sandbox failure modes a
    // Flatpak/Snap confinement produces — a seccomp-filtered `socket(2)`
    // (`EPERM`) or a denied multicast `bind(2)` (`EPERM`/`EACCES`) — must
    // map to `Privilege` so the UI shows the `CAP_NET_ADMIN` hint, NOT the
    // generic `Other` message. Pinned here so a refactor of `from_io`
    // cannot silently demote the privilege case. No socket/sandbox needed:
    // we drive `from_io` with synthetic `io::Error`s by errno.
    // ------------------------------------------------------------------

    fn classifies(errno: libc::c_int) -> StartError {
        StartError::from_io("test", &io::Error::from_raw_os_error(errno))
    }

    #[test]
    fn eperm_classifies_as_privilege() {
        // Seccomp-filtered `socket()` and a denied multicast `bind()` both
        // surface as EPERM under Flatpak/Snap confinement.
        assert!(matches!(classifies(libc::EPERM), StartError::Privilege));
    }

    #[test]
    fn eacces_classifies_as_privilege() {
        // Some kernels/sandboxes deny the bind with EACCES instead of EPERM.
        assert!(matches!(classifies(libc::EACCES), StartError::Privilege));
    }

    #[test]
    fn non_privilege_errnos_classify_as_other() {
        // A genuinely different failure (bad argument, out of buffers, no
        // such device) must NOT be mislabelled as a privilege problem — the
        // UI would otherwise tell the user to grant CAP_NET_ADMIN for an
        // unrelated cause.
        for errno in [
            libc::EINVAL,
            libc::ENOBUFS,
            libc::ENODEV,
            libc::EAFNOSUPPORT,
        ] {
            assert!(
                matches!(classifies(errno), StartError::Other(_)),
                "errno {errno} should be Other, not Privilege"
            );
        }
    }

    #[test]
    fn other_variant_preserves_context_and_errno_message() {
        // The `Other` payload is what surfaces to the user for diagnosis, so
        // it must carry both the call-site context and the OS message.
        let err = StartError::from_io(
            "failed to bind netlink connector socket",
            &io::Error::from_raw_os_error(libc::EINVAL),
        );
        match err {
            StartError::Other(msg) => {
                assert!(msg.contains("failed to bind netlink connector socket"));
                // EINVAL's strerror text ("Invalid argument") is appended.
                assert!(
                    msg.to_lowercase().contains("invalid argument"),
                    "got: {msg}"
                );
            }
            StartError::Privilege => panic!("EINVAL must not be Privilege"),
        }
    }
}
