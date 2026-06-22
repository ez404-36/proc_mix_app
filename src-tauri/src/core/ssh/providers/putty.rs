//! PuTTY saved-sessions provider — **stub** (not yet implemented).
//!
//! PuTTY stores sessions in the Windows registry under
//! `HKCU\Software\SimonTatham\PuTTY\Sessions\<name>`, with per-session values
//! (`HostName`, `PortNumber`, `UserName`, …) and a separate `.ppk` key format.
//! Reading that is a distinct, Windows-only concern with its own value
//! mapping, so it is deferred to a later iteration.
//!
//! This stub exists so the provider is already wired into the registry and
//! the [`SshSource::Putty`] variant has a home: filling it in later means
//! implementing [`SshSourceProvider::list_hosts`] here and flipping
//! [`SshSourceProvider::is_available`] — no registry/IPC/UI churn.
//!
//! Gated to Windows: PuTTY's registry hive only exists there.

use super::super::provider::SshSourceProvider;
use super::super::types::{SshHost, SshSource, SshSourceError};

/// Stub provider for PuTTY saved sessions. Always reports unavailable until
/// the registry reader is implemented.
pub struct PuttyProvider;

impl PuttyProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PuttyProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SshSourceProvider for PuttyProvider {
    fn source(&self) -> SshSource {
        SshSource::Putty
    }

    fn is_available(&self) -> bool {
        // TODO(ssh-putty): probe HKCU\Software\SimonTatham\PuTTY\Sessions and
        // return true when the key exists. Stub: never available yet.
        false
    }

    fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
        // Unreachable while is_available() is false (the registry skips
        // unavailable providers), but return an empty inventory rather than
        // erroring so a future direct caller is safe.
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_is_unavailable_and_empty() {
        let p = PuttyProvider::new();
        assert_eq!(p.source(), SshSource::Putty);
        assert!(!p.is_available());
        assert!(p.list_hosts().unwrap().is_empty());
    }
}
