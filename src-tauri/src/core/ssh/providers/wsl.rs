//! WSL `~/.ssh/config` provider — **stub** (not yet implemented).
//!
//! A WSL distribution keeps its own `~/.ssh/config` inside the Linux
//! filesystem (reachable from Windows via `\\wsl$\<distro>\home\<user>\…`),
//! separate from the Windows-side `%USERPROFILE%\.ssh\config` that
//! [`super::openssh`] already reads. Enumerating distros and locating each
//! user's home is a distinct concern, deferred to a later iteration.
//!
//! Stub-only: wired into the registry so [`SshSource::Wsl`] has a home and a
//! future implementation needs no contract changes.

use super::super::provider::SshSourceProvider;
use super::super::types::{SshHost, SshSource, SshSourceError};

/// Stub provider for WSL distribution SSH configs.
pub struct WslProvider;

impl WslProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WslProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SshSourceProvider for WslProvider {
    fn source(&self) -> SshSource {
        SshSource::Wsl
    }

    fn is_available(&self) -> bool {
        // TODO(ssh-wsl): detect installed WSL distros (`wsl -l -q`) and probe
        // each home's ~/.ssh/config. Stub: never available yet.
        false
    }

    fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_is_unavailable_and_empty() {
        let p = WslProvider::new();
        assert_eq!(p.source(), SshSource::Wsl);
        assert!(!p.is_available());
        assert!(p.list_hosts().unwrap().is_empty());
    }
}
