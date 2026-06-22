//! Aggregates every available [`SshSourceProvider`] into one deduplicated
//! host inventory for the UI.
//!
//! The registry is the single place that knows the full provider set for the
//! current OS. It:
//!   1. builds the providers compiled for this platform,
//!   2. skips any that report `is_available() == false`,
//!   3. lists each available provider's hosts, isolating per-source failures
//!      (one broken source never sinks the whole inventory),
//!   4. deduplicates by [`SshHostId::key`] (first occurrence wins).
//!
//! ## Deduplication semantics
//!
//! The key is `"<source>:<name>"`, so:
//!   - the SAME alias in DIFFERENT sources stays distinct (both shown with
//!     their source badge) — intentional, they are different connections;
//!   - WITHIN one source, repeats collapse. This matters for OpenSSH, where
//!     an `Include` cycle or a re-declared `Host` can yield duplicates; the
//!     primary file is parsed first, so its definition wins over an included
//!     one.

use super::provider::SshSourceProvider;
use super::providers::{OpenSshProvider, PuttyProvider, SystemConfigProvider, WslProvider};
use super::types::{SshHost, SshSource};

/// Per-source availability + error status, surfaced to the UI so it can
/// explain why a source contributed nothing (unavailable vs failed to read).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSourceStatus {
    pub source: SshSource,
    /// Whether the source exists on this machine.
    pub available: bool,
    /// Whether ProcMix has a real reader for this source yet (vs a stub).
    pub implemented: bool,
    /// Read/parse error message when listing failed, else `None`.
    pub error: Option<String>,
}

/// The full inventory: deduplicated connectable hosts, the wildcard/pattern
/// blocks (rules that apply to groups of hosts, surfaced separately and
/// read-only), and per-source status.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshInventory {
    /// Concrete, connectable hosts shown in the main Connections list.
    pub hosts: Vec<SshHost>,
    /// Wildcard/pattern blocks (`Host *`, `*.example.com`, `web?`, `!neg`) —
    /// matching rules, not connections. Shown in a separate read-only
    /// "Rules & templates" section; never connectable/checkable.
    pub patterns: Vec<SshHost>,
    pub sources: Vec<SshSourceStatus>,
}

/// Which sources have a real reader in THIS build. Stubs are excluded so the
/// UI can show "not yet supported" distinctly from "available but empty".
fn is_implemented(source: SshSource) -> bool {
    matches!(source, SshSource::OpenSshConfig | SshSource::SystemConfig)
}

/// Build the set of providers compiled for the current OS.
///
/// OpenSSH is everywhere. PuTTY and WSL are Windows-only sources (gated so
/// they aren't even constructed elsewhere). The system config exists on all
/// platforms. Adding a source = add its provider here behind the right
/// `#[cfg]`; nothing else in the registry changes.
fn build_providers() -> Vec<Box<dyn SshSourceProvider>> {
    let mut providers: Vec<Box<dyn SshSourceProvider>> = Vec::new();

    // OpenSSH ~/.ssh/config — cross-platform. `None` (no resolvable home)
    // simply omits it, which surfaces as an absent source.
    if let Some(p) = OpenSshProvider::for_current_user() {
        providers.push(Box::new(p));
    }

    // System-wide ssh_config — exists on every platform (stub for now).
    providers.push(Box::new(SystemConfigProvider::new()));

    // Windows-only sources.
    #[cfg(target_os = "windows")]
    {
        providers.push(Box::new(PuttyProvider::new()));
        providers.push(Box::new(WslProvider::new()));
    }

    // Keep the non-Windows build from flagging the imports as unused without
    // resorting to `#[allow]`: reference the types in a zero-cost way.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (PuttyProvider::new, WslProvider::new);
    }

    providers
}

/// Whether a host name is a concrete, connectable alias rather than a
/// wildcard/pattern. Blocks like `Host *` (global defaults) or
/// `Host *.example.com` / `Host web?` / `Host !neg` are matching RULES, not
/// connections — you cannot connect to or check a pattern — so they are
/// excluded from the inventory the UI lists.
fn is_connectable_host(name: &str) -> bool {
    !name.is_empty() && !name.contains('*') && !name.contains('?') && !name.starts_with('!')
}

/// Collect the deduplicated host inventory across all available providers.
///
/// Pure aggregation over an injected provider list — see [`load_inventory`]
/// for the production entry point that builds the OS provider set.
fn aggregate(providers: &[Box<dyn SshSourceProvider>]) -> SshInventory {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut patterns: Vec<SshHost> = Vec::new();
    // Independent dedup sets. A host and a pattern can never share a key (a
    // pattern name always contains `*`/`?`/`!`), but keeping them separate
    // keeps "first occurrence wins" correct within each list.
    let mut seen_hosts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_patterns: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sources: Vec<SshSourceStatus> = Vec::new();

    for provider in providers {
        let source = provider.source();
        let available = provider.is_available();
        let mut error = None;

        if available {
            match provider.list_hosts() {
                Ok(found) => {
                    for host in found {
                        let key = host.id.key();
                        // Split connectable hosts from wildcard/pattern blocks
                        // (`Host *` defaults, `*.example.com`, …). Both are
                        // surfaced, but in different UI sections. First
                        // occurrence wins within each list (primary file before
                        // includes, earlier provider before later).
                        if is_connectable_host(&host.name) {
                            if seen_hosts.insert(key) {
                                hosts.push(host);
                            }
                        } else if seen_patterns.insert(key) {
                            patterns.push(host);
                        }
                    }
                }
                Err(e) => error = Some(e.to_string()),
            }
        }

        sources.push(SshSourceStatus {
            source,
            available,
            implemented: is_implemented(source),
            error,
        });
    }

    SshInventory {
        hosts,
        patterns,
        sources,
    }
}

/// Production entry point: build the OS provider set and aggregate it.
pub fn load_inventory() -> SshInventory {
    aggregate(&build_providers())
}

/// Return a writer for `source`, or `None` when that source is read-only in
/// this build. Only [`SshSource::OpenSshConfig`] is writable today; the stub
/// sources never return a writer. The write commands gate on this — a write
/// to a read-only source fails cleanly rather than silently no-op'ing.
pub fn writer_for(source: SshSource) -> Option<Box<dyn super::provider::SshSourceWriter>> {
    match source {
        SshSource::OpenSshConfig => {
            OpenSshProvider::for_current_user().map(|p| Box::new(p) as Box<_>)
        }
        SshSource::Putty | SshSource::Wsl | SshSource::SystemConfig => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::types::{SshHostId, SshSourceError};

    /// Configurable fake provider for aggregation tests.
    struct Fake {
        source: SshSource,
        available: bool,
        result: Result<Vec<SshHost>, String>,
    }

    impl SshSourceProvider for Fake {
        fn source(&self) -> SshSource {
            self.source
        }
        fn is_available(&self) -> bool {
            self.available
        }
        fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
            self.result.clone().map_err(SshSourceError::Read)
        }
    }

    fn host(source: SshSource, name: &str) -> SshHost {
        SshHost {
            id: SshHostId::new(source, name),
            name: name.to_string(),
            host_name: None,
            user: None,
            port: None,
            identity_file: None,
            editable_params: true,
            editable_name: true,
            deletable: true,
            source_detail: "test".into(),
            raw_text: format!("Host {name}"),
        }
    }

    fn boxed(f: Fake) -> Box<dyn SshSourceProvider> {
        Box::new(f)
    }

    #[test]
    fn aggregates_available_providers() {
        let providers = vec![boxed(Fake {
            source: SshSource::OpenSshConfig,
            available: true,
            result: Ok(vec![
                host(SshSource::OpenSshConfig, "a"),
                host(SshSource::OpenSshConfig, "b"),
            ]),
        })];
        let inv = aggregate(&providers);
        assert_eq!(inv.hosts.len(), 2);
        assert_eq!(inv.sources.len(), 1);
        assert!(inv.sources[0].available);
        assert!(inv.sources[0].error.is_none());
    }

    #[test]
    fn wildcard_and_pattern_blocks_go_to_patterns_not_hosts() {
        // `Host *` (global defaults), globs and negations are rules, not
        // connections: they belong in `patterns`, not the main `hosts` list.
        let providers = vec![boxed(Fake {
            source: SshSource::SystemConfig,
            available: true,
            result: Ok(vec![
                host(SshSource::SystemConfig, "*"),
                host(SshSource::SystemConfig, "*.example.com"),
                host(SshSource::SystemConfig, "web?"),
                host(SshSource::SystemConfig, "!secret"),
                host(SshSource::SystemConfig, "real"),
            ]),
        })];
        let inv = aggregate(&providers);

        let host_names: Vec<&str> = inv.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(host_names, vec!["real"], "only the concrete host in hosts");

        let pattern_names: Vec<&str> = inv.patterns.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(
            pattern_names,
            vec!["*", "*.example.com", "web?", "!secret"],
            "all patterns surfaced separately"
        );
    }

    #[test]
    fn is_connectable_host_classification() {
        assert!(is_connectable_host("prod"));
        assert!(is_connectable_host("db-1.example.com"));
        assert!(!is_connectable_host("*"));
        assert!(!is_connectable_host("*.example.com"));
        assert!(!is_connectable_host("web?"));
        assert!(!is_connectable_host("!neg"));
        assert!(!is_connectable_host(""));
    }

    #[test]
    fn dedups_repeats_within_a_source_first_wins() {
        let mut first = host(SshSource::OpenSshConfig, "dup");
        first.user = Some("primary".into());
        let mut second = host(SshSource::OpenSshConfig, "dup");
        second.user = Some("included".into());

        let providers = vec![boxed(Fake {
            source: SshSource::OpenSshConfig,
            available: true,
            result: Ok(vec![first, second]),
        })];
        let inv = aggregate(&providers);
        assert_eq!(inv.hosts.len(), 1);
        // The first (primary) definition wins.
        assert_eq!(inv.hosts[0].user.as_deref(), Some("primary"));
    }

    #[test]
    fn same_name_different_sources_are_both_kept() {
        let providers = vec![
            boxed(Fake {
                source: SshSource::OpenSshConfig,
                available: true,
                result: Ok(vec![host(SshSource::OpenSshConfig, "prod")]),
            }),
            boxed(Fake {
                source: SshSource::Putty,
                available: true,
                result: Ok(vec![host(SshSource::Putty, "prod")]),
            }),
        ];
        let inv = aggregate(&providers);
        assert_eq!(inv.hosts.len(), 2);
    }

    #[test]
    fn unavailable_provider_contributes_no_hosts_but_reports_status() {
        let providers = vec![boxed(Fake {
            source: SshSource::Putty,
            available: false,
            result: Ok(vec![host(SshSource::Putty, "ignored")]),
        })];
        let inv = aggregate(&providers);
        assert!(inv.hosts.is_empty());
        assert_eq!(inv.sources.len(), 1);
        assert!(!inv.sources[0].available);
    }

    #[test]
    fn provider_error_is_isolated_not_fatal() {
        let providers = vec![
            boxed(Fake {
                source: SshSource::OpenSshConfig,
                available: true,
                result: Ok(vec![host(SshSource::OpenSshConfig, "ok")]),
            }),
            boxed(Fake {
                source: SshSource::SystemConfig,
                available: true,
                result: Err("boom".into()),
            }),
        ];
        let inv = aggregate(&providers);
        // The healthy source's host still made it in.
        assert_eq!(inv.hosts.len(), 1);
        assert_eq!(inv.hosts[0].name, "ok");
        // The failing source reports its error.
        let sys = inv
            .sources
            .iter()
            .find(|s| s.source == SshSource::SystemConfig)
            .unwrap();
        assert!(sys.error.as_deref().unwrap().contains("boom"));
    }

    #[test]
    fn implemented_flag_tracks_real_readers() {
        assert!(is_implemented(SshSource::OpenSshConfig));
        assert!(is_implemented(SshSource::SystemConfig));
        // PuTTY and WSL remain stubs.
        assert!(!is_implemented(SshSource::Putty));
        assert!(!is_implemented(SshSource::Wsl));
    }

    #[test]
    fn load_inventory_runs_on_this_host_without_panicking() {
        // Smoke test: the production path must not panic regardless of
        // whether this machine has a ~/.ssh/config. We don't assert on
        // host contents (environment-dependent), only on shape.
        let inv = load_inventory();
        // OpenSSH + System are always registered; Windows adds two more.
        assert!(inv
            .sources
            .iter()
            .any(|s| s.source == SshSource::OpenSshConfig));
        assert!(inv
            .sources
            .iter()
            .any(|s| s.source == SshSource::SystemConfig));
    }

    #[test]
    fn writer_for_returns_only_openssh() {
        // OpenSSH is writable (when a home dir resolves, which it does in the
        // test environment); the stub sources never return a writer.
        assert!(writer_for(SshSource::OpenSshConfig).is_some());
        assert!(writer_for(SshSource::Putty).is_none());
        assert!(writer_for(SshSource::Wsl).is_none());
        assert!(writer_for(SshSource::SystemConfig).is_none());
    }
}
