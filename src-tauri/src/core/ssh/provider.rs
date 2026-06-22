//! The extension point for SSH connection sources.
//!
//! Each place SSH connections can live (OpenSSH's `~/.ssh/config`, PuTTY's
//! registry sessions, a WSL distro's config, the system-wide `ssh_config`,
//! …) is modelled as an [`SshSourceProvider`]. The registry in
//! [`super::registry`] holds the set of providers compiled for the current
//! OS, asks each whether it [`is_available`](SshSourceProvider::is_available)
//! on this machine, and aggregates the hosts they
//! [`list_hosts`](SshSourceProvider::list_hosts).
//!
//! ## Adding a new source
//!
//! 1. Add a variant to [`super::types::SshSource`] (and its TS mirror).
//! 2. Add a module under `providers/` implementing this trait.
//! 3. Register it in [`super::registry::providers`] (one line, behind the
//!    appropriate `#[cfg]` if the source is OS-specific).
//!
//! Nothing else — the IPC commands, the store, and the UI iterate the
//! registry generically, so a new source needs no changes there.
//!
//! ## Read-only by design (this iteration)
//!
//! This trait intentionally exposes ONLY reads. Writing back to a source
//! (creating/editing a host) is a separate, riskier concern — it must do a
//! surgical edit that preserves user comments/formatting, take a backup, and
//! write atomically. That will live behind a distinct `SshSourceWriter`
//! trait added in a later iteration, so a provider can support reading long
//! before (or without ever) supporting writing.

use super::types::{SshHost, SshHostDraft, SshSource, SshSourceError, SshWriteError};

/// A read-only source of SSH host definitions.
///
/// Implementations MUST be cheap to construct (the registry instantiates one
/// per call) and side-effect-free aside from reading their backing store.
/// `Send + Sync` so the registry can be used from async command handlers.
pub trait SshSourceProvider: Send + Sync {
    /// Which source this provider represents. Used to tag every [`SshHost`]
    /// it returns and to let the UI group/badge by origin.
    fn source(&self) -> SshSource;

    /// Whether this source exists on the current machine RIGHT NOW.
    ///
    /// Returning `false` excludes the provider from the inventory without it
    /// being an error (e.g. there is no `~/.ssh/config` yet, or PuTTY is not
    /// installed). Must NOT perform expensive work — a `path.exists()` /
    /// registry-key probe is the expected cost. The registry skips
    /// `list_hosts` for any provider that reports unavailable.
    fn is_available(&self) -> bool;

    /// Parse and return every host this source declares.
    ///
    /// Read-only: no side effects on the backing store. Errors are returned
    /// (not panicked) so the registry can surface a per-source failure
    /// without sinking the whole inventory. An available source with no
    /// hosts returns `Ok(vec![])`.
    fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError>;
}

/// A source that additionally supports **writing** host definitions back.
///
/// Kept separate from [`SshSourceProvider`] so a source can support reading
/// long before (or without ever) supporting writing — only `OpenSshConfig`
/// implements this today; the stub sources never will until their formats are
/// modelled for write.
///
/// ## Contract
///
/// Implementations MUST:
///   * validate the draft (alias shape, port range, no newline-bearing
///     values) and reject with [`SshWriteError::Validation`] before touching
///     the file;
///   * refuse to write a block that is not ProcMix-editable
///     ([`SshWriteError::ReadOnly`]);
///   * preserve unrelated content (comments, other blocks, unknown
///     directives) — i.e. perform a surgical edit, never a full rewrite;
///   * write durably and safely: back up the file on first modification,
///     write atomically (temp + rename), and restore restrictive
///     permissions (`0600`) on Unix;
///   * re-parse the result and abort with [`SshWriteError::Corruption`] if it
///     no longer yields the expected editable host.
pub trait SshSourceWriter: Send + Sync {
    /// Which source this writer targets.
    fn source(&self) -> SshSource;

    /// Create or update the host described by `draft`. When
    /// `draft.previous_name` is set and differs from `draft.name`, the old
    /// block is removed (a rename).
    fn upsert_host(&self, draft: &SshHostDraft) -> Result<(), SshWriteError>;

    /// Remove the host named `alias`. Removing a non-existent host is a
    /// success (idempotent) — the desired end state already holds.
    fn delete_host(&self, alias: &str) -> Result<(), SshWriteError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::types::SshHostId;

    /// A trivial in-memory provider proving the trait is object-safe and can
    /// be boxed into the registry's `Vec<Box<dyn SshSourceProvider>>`.
    struct FakeProvider {
        available: bool,
        hosts: Vec<SshHost>,
    }

    impl SshSourceProvider for FakeProvider {
        fn source(&self) -> SshSource {
            SshSource::OpenSshConfig
        }
        fn is_available(&self) -> bool {
            self.available
        }
        fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
            Ok(self.hosts.clone())
        }
    }

    fn sample_host() -> SshHost {
        SshHost {
            id: SshHostId::new(SshSource::OpenSshConfig, "prod"),
            name: "prod".into(),
            host_name: Some("prod.example.com".into()),
            user: Some("deploy".into()),
            port: Some(22),
            identity_file: None,
            editable_params: true,
            editable_name: true,
            deletable: true,
            source_detail: "/home/u/.ssh/config".into(),
            raw_text: "Host prod\n    HostName prod.example.com\n    User deploy\n    Port 22"
                .into(),
        }
    }

    #[test]
    fn trait_is_object_safe_and_boxable() {
        let providers: Vec<Box<dyn SshSourceProvider>> = vec![
            Box::new(FakeProvider {
                available: true,
                hosts: vec![sample_host()],
            }),
            Box::new(FakeProvider {
                available: false,
                hosts: vec![],
            }),
        ];

        let mut listed = 0;
        for p in &providers {
            if p.is_available() {
                listed += p.list_hosts().expect("list").len();
            }
        }
        assert_eq!(listed, 1);
    }
}
