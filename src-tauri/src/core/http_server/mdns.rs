// Zero-config LAN discovery for the built-in HTTP server.
//
// When the server starts we announce two things over multicast DNS (mDNS /
// DNS-SD, RFC 6762/6763) so other machines on the same subnet can reach it
// without any manual setup:
//
//   1. A hostname `procmix.local` → the machine's LAN IPv4 (an A record). This
//      is what a user types in a browser: `http://procmix.local:<port>`.
//      macOS (Bonjour) and Windows 10/11 resolve `*.local` out of the box;
//      Linux clients need `avahi-daemon` (installed on virtually every desktop).
//
//   2. An `_http._tcp.local` service instance named "ProcMix" so service
//      browsers (e.g. "Bonjour Browser", `avahi-browse`) can discover it.
//
// IMPORTANT — naming: mDNS only resolves SINGLE-label hostnames under `.local`
// (`procmix.local`). A multi-label host such as `procmix.server.local` is NOT
// resolvable as an A record by stock Bonjour/Avahi/Windows resolvers, so we do
// not offer it — it would be a broken promise. The service INSTANCE name may be
// arbitrary, but the addressable HOSTNAME stays `procmix.local`.
//
// Security note: the announcement carries only the hostname, IP, and port —
// never the Bearer token. Discovery does not grant access; every `/api/*` call
// still requires the token. Announcing is harmless on a LAN the user has
// already opted into (the server binds `0.0.0.0` only when `bind_lan` is set;
// on localhost-only we still announce, but the A record points at the LAN IP so
// remote clients simply can't connect to a 127.0.0.1-bound socket).

use std::net::{IpAddr, Ipv4Addr};

use mdns_sd::{ServiceDaemon, ServiceInfo};

/// The single-label `.local` hostname we advertise. Stock mDNS resolvers
/// (macOS/Windows/avahi) turn `procmix.local` into the announced A record.
pub const MDNS_HOSTNAME: &str = "procmix.local.";

/// Service type for the DNS-SD browse list. The trailing `.local.` is required
/// by `mdns-sd`.
const SERVICE_TYPE: &str = "_http._tcp.local.";

/// Human-readable instance name shown in service browsers.
const INSTANCE_NAME: &str = "ProcMix";

/// A live mDNS announcement. Dropping it (or calling [`MdnsAnnouncement::stop`])
/// unregisters the service and shuts the daemon down, withdrawing the records
/// from the network.
pub struct MdnsAnnouncement {
    daemon: ServiceDaemon,
    /// Full registered name (`ProcMix._http._tcp.local.`) used to unregister.
    fullname: String,
}

impl MdnsAnnouncement {
    /// Start announcing `procmix.local` → `ip` and the `_http._tcp` service on
    /// `port`. Returns `None` (best-effort) if the platform mDNS responder is
    /// unavailable — e.g. no `avahi-daemon` on a headless Linux box — so a
    /// missing responder never blocks the HTTP server from starting.
    pub fn start(ip: Ipv4Addr, port: u16) -> Option<Self> {
        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("http_server: mDNS daemon unavailable, skipping announce: {e}");
                return None;
            }
        };

        // No TXT properties: discovery exposes only host/ip/port (the token is
        // never advertised). An empty slice satisfies `IntoTxtProperties`.
        let props: &[(&str, &str)] = &[];
        let info = match ServiceInfo::new(
            SERVICE_TYPE,
            INSTANCE_NAME,
            MDNS_HOSTNAME,
            IpAddr::V4(ip),
            port,
            props,
        ) {
            Ok(info) => info,
            Err(e) => {
                eprintln!("http_server: failed to build mDNS service info: {e}");
                let _ = daemon.shutdown();
                return None;
            }
        };

        let fullname = info.get_fullname().to_string();
        if let Err(e) = daemon.register(info) {
            eprintln!("http_server: mDNS register failed: {e}");
            let _ = daemon.shutdown();
            return None;
        }

        Some(Self { daemon, fullname })
    }

    /// Withdraw the announcement: unregister the service (sending a goodbye
    /// packet so caches expire promptly) and shut the daemon down. Best-effort
    /// — errors are logged, not propagated, because stopping the HTTP server
    /// must always succeed.
    pub fn stop(self) {
        if let Err(e) = self.daemon.unregister(&self.fullname) {
            eprintln!("http_server: mDNS unregister failed: {e}");
        }
        if let Err(e) = self.daemon.shutdown() {
            eprintln!("http_server: mDNS shutdown failed: {e}");
        }
    }
}

/// Best-effort detection of this machine's primary LAN IPv4.
///
/// Returns the OS-reported default-route local address when it is a routable
/// IPv4 (not loopback, not link-local `169.254/16`). `None` when the machine is
/// offline or only has loopback / IPv6 — in which case mDNS is skipped and the
/// UI falls back to showing `127.0.0.1`.
pub fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    match local_ip_address::local_ip() {
        Ok(std::net::IpAddr::V4(v4)) if is_routable_lan(v4) => Some(v4),
        _ => None,
    }
}

/// Whether `ip` is a usable LAN address (not loopback / unspecified / the
/// `169.254/16` link-local block that signals "no DHCP lease").
fn is_routable_lan(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_loopback_and_link_local() {
        assert!(!is_routable_lan(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_routable_lan(Ipv4Addr::new(0, 0, 0, 0)));
        assert!(!is_routable_lan(Ipv4Addr::new(169, 254, 1, 1)));
    }

    #[test]
    fn accepts_private_lan_ranges() {
        assert!(is_routable_lan(Ipv4Addr::new(192, 168, 1, 42)));
        assert!(is_routable_lan(Ipv4Addr::new(10, 0, 0, 5)));
        assert!(is_routable_lan(Ipv4Addr::new(172, 16, 3, 9)));
    }

    /// The advertised hostname must stay the single-label `.local` form — a
    /// multi-label name like `procmix.server.local` is not resolvable by stock
    /// mDNS responders, so this guards against a well-meaning "improvement".
    #[test]
    fn hostname_is_single_label_dot_local() {
        let trimmed = MDNS_HOSTNAME.trim_end_matches('.');
        assert_eq!(trimmed, "procmix.local");
        // Exactly one label before `.local`.
        assert_eq!(trimmed.matches('.').count(), 1);
    }
}
