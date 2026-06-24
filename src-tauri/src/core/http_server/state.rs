// Managed Tauri state for the built-in HTTP server.
//
// Holds the running task's handle + shutdown signal, the live config snapshot,
// the request log ring buffer, and the anti-brute-force 401 rate limiter. By
// the `SchedulerState` / `WatcherState` precedent this is wrapped in an `Arc`
// and stored via `app.manage(...)`; the Tauri commands and the setup hook share
// the single instance.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use tauri::async_runtime::JoinHandle;
use tokio::sync::{Mutex, Notify};

use crate::storage::http_server::HttpServerConfig;

use super::log::RequestLog;
use super::mdns::MdnsAnnouncement;

/// Window (seconds) over which failed-auth attempts from one IP are counted.
const RATE_LIMIT_WINDOW_SECS: u64 = 60;

/// Max failed-auth (`401`) attempts allowed per IP within
/// [`RATE_LIMIT_WINDOW_SECS`] before further requests from that IP are rejected
/// outright (also `401`, but without comparing the token). Defeats an online
/// brute-force of the Bearer token.
const RATE_LIMIT_MAX_FAILURES: u32 = 10;

/// The mutable part of the server state, guarded by a single async `Mutex` so
/// start/stop/restart are serialised (no two starts race to bind the port).
#[derive(Default)]
struct Inner {
    /// `Some` while the axum task is running. `None` when stopped.
    handle: Option<JoinHandle<()>>,
    /// Pulsed to trigger graceful shutdown of the running task.
    shutdown: Option<Arc<Notify>>,
    /// The config the running task was started with (port / bind / log flag).
    /// `None` when stopped. Read by `status` so the UI shows the LIVE bind, not
    /// the persisted config (which may have been edited without a restart).
    running_config: Option<HttpServerConfig>,
    /// Live mDNS announcement (`procmix.local` + `_http._tcp` service), present
    /// while running AND the platform responder was available. `None` when
    /// stopped or when mDNS could not start (best-effort). Dropped on stop,
    /// which withdraws the records from the network.
    mdns: Option<MdnsAnnouncement>,
    /// The LAN IPv4 the running instance was announced on, surfaced in the
    /// status so the UI can show `http://<ip>:<port>` as a reliable fallback.
    /// `None` when the machine has no routable LAN address.
    lan_ip: Option<Ipv4Addr>,
}

/// Per-IP failed-attempt counter for the 401 rate limiter. Tracks the count and
/// the window start; entries reset when their window elapses.
#[derive(Default)]
struct RateLimiter {
    /// ip -> (failure_count, window_start_epoch_secs).
    failures: HashMap<IpAddr, (u32, u64)>,
}

impl RateLimiter {
    /// Returns `true` when the IP is currently OVER the failure threshold and
    /// must be rejected without even comparing the token. Does not mutate.
    fn is_blocked(&self, ip: &IpAddr, now: u64) -> bool {
        match self.failures.get(ip) {
            Some(&(count, started)) => {
                now.saturating_sub(started) < RATE_LIMIT_WINDOW_SECS
                    && count >= RATE_LIMIT_MAX_FAILURES
            }
            None => false,
        }
    }

    /// Record one failed-auth attempt for `ip`, resetting the window if the
    /// previous one elapsed.
    fn record_failure(&mut self, ip: IpAddr, now: u64) {
        let entry = self.failures.entry(ip).or_insert((0, now));
        if now.saturating_sub(entry.1) >= RATE_LIMIT_WINDOW_SECS {
            *entry = (1, now);
        } else {
            entry.0 = entry.0.saturating_add(1);
        }
    }
}

/// Managed HTTP-server state. Cheap to clone the `Arc`; the heavy fields live
/// behind it.
pub struct HttpServerState {
    inner: Mutex<Inner>,
    /// Request log (ring buffer + file path), shared into the running task's
    /// handlers via an `Arc`.
    pub request_log: Arc<RequestLog>,
    rate_limiter: Mutex<RateLimiter>,
}

impl HttpServerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            request_log: Arc::new(RequestLog::new()),
            rate_limiter: Mutex::new(RateLimiter::default()),
        }
    }

    /// Whether the server is currently running.
    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.handle.is_some()
    }

    /// The config the running task was started with, if running.
    pub async fn running_config(&self) -> Option<HttpServerConfig> {
        self.inner.lock().await.running_config.clone()
    }

    /// The LAN IPv4 the running instance was announced on, if any.
    pub async fn lan_ip(&self) -> Option<Ipv4Addr> {
        self.inner.lock().await.lan_ip
    }

    /// Install the running task's handle, shutdown signal, config, and the
    /// (optional) live mDNS announcement + LAN IP. Called by the lifecycle layer
    /// after a successful bind.
    pub async fn set_running(
        &self,
        handle: JoinHandle<()>,
        shutdown: Arc<Notify>,
        config: HttpServerConfig,
        mdns: Option<MdnsAnnouncement>,
        lan_ip: Option<Ipv4Addr>,
    ) {
        let mut inner = self.inner.lock().await;
        inner.handle = Some(handle);
        inner.shutdown = Some(shutdown);
        inner.running_config = Some(config);
        inner.mdns = mdns;
        inner.lan_ip = lan_ip;
    }

    /// Signal the running task to stop and clear the running state. Returns the
    /// `JoinHandle` (if any) so the caller can await the task's exit. Withdraws
    /// the mDNS announcement (drops it, sending the goodbye packet). Idempotent
    /// — a no-op when already stopped.
    pub async fn take_for_stop(&self) -> Option<JoinHandle<()>> {
        let mut inner = self.inner.lock().await;
        if let Some(shutdown) = inner.shutdown.take() {
            shutdown.notify_waiters();
        }
        // Withdraw the mDNS records before the socket goes away so a browser
        // doesn't keep a stale `procmix.local` cached as long.
        if let Some(mdns) = inner.mdns.take() {
            mdns.stop();
        }
        inner.lan_ip = None;
        inner.running_config = None;
        inner.handle.take()
    }

    /// Rate-limit gate: returns `true` when `ip` has exceeded the failed-auth
    /// threshold inside the current window and must be rejected immediately.
    pub async fn is_rate_limited(&self, ip: IpAddr) -> bool {
        let now = now_epoch_secs();
        self.rate_limiter.lock().await.is_blocked(&ip, now)
    }

    /// Record one failed-auth attempt for `ip`.
    pub async fn record_auth_failure(&self, ip: IpAddr) {
        let now = now_epoch_secs();
        self.rate_limiter.lock().await.record_failure(ip, now);
    }
}

impl Default for HttpServerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Current Unix time in whole seconds. Used by the rate limiter's window math.
fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip() -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))
    }

    /// The limiter must block only AFTER the threshold is reached within the
    /// window, and reset once the window elapses.
    #[test]
    fn rate_limiter_blocks_after_threshold_then_resets() {
        let mut rl = RateLimiter::default();
        let now = 1_000;
        for _ in 0..RATE_LIMIT_MAX_FAILURES {
            assert!(!rl.is_blocked(&ip(), now), "not blocked before threshold");
            rl.record_failure(ip(), now);
        }
        assert!(rl.is_blocked(&ip(), now), "blocked once at threshold");

        // After the window elapses the counter resets and the IP is allowed
        // again on the next failure (which starts a fresh window at count 1).
        let later = now + RATE_LIMIT_WINDOW_SECS + 1;
        assert!(!rl.is_blocked(&ip(), later), "window elapsed → unblocked");
        rl.record_failure(ip(), later);
        assert!(!rl.is_blocked(&ip(), later), "fresh window, count 1 < threshold");
    }

    #[tokio::test]
    async fn state_starts_stopped() {
        let state = HttpServerState::new();
        assert!(!state.is_running().await);
        assert!(state.running_config().await.is_none());
        // take_for_stop on a stopped server is a harmless no-op.
        assert!(state.take_for_stop().await.is_none());
    }
}
