//! System-wide SSH client config provider.
//!
//! Reads the machine-wide client config — `/etc/ssh/ssh_config` on Unix,
//! `C:\ProgramData\ssh\ssh_config` on Windows — which uses the SAME grammar as
//! the user file, so it reuses [`super::openssh_parse`] directly.
//!
//! **Read-only by definition:** the system config is typically root-owned and
//! describes machine policy, so every host surfaced here is forced to
//! `editable = false` regardless of its block shape. ProcMix never offers to
//! edit or delete these — there is no [`super::super::provider::SshSourceWriter`]
//! for this source (the registry's `writer_for` returns `None`).
//!
//! Scope: only the primary file is parsed. System configs frequently `Include`
//! a `ssh_config.d/` drop-in directory; surfacing those is left as future work
//! (the hosts would still be read-only). A missing file simply makes the
//! source unavailable.

use std::path::PathBuf;

use super::super::provider::SshSourceProvider;
use super::super::types::{SshHost, SshHostId, SshSource, SshSourceError};
use super::openssh_parse;

/// Provider backed by the platform's system-wide `ssh_config`.
pub struct SystemConfigProvider {
    config_path: PathBuf,
}

impl SystemConfigProvider {
    /// Build a provider pointing at the platform's system config path.
    pub fn new() -> Self {
        Self {
            config_path: default_system_path(),
        }
    }

    /// Construct a provider for an explicit config path (tests).
    #[cfg(test)]
    pub fn with_config_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }
}

impl Default for SystemConfigProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// The conventional system client-config path for the current OS.
fn default_system_path() -> PathBuf {
    #[cfg(windows)]
    {
        // ProgramData is the machine-wide config root for Win32-OpenSSH.
        let base = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("ssh").join("ssh_config")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/etc/ssh/ssh_config")
    }
}

impl SshSourceProvider for SystemConfigProvider {
    fn source(&self) -> SshSource {
        SshSource::SystemConfig
    }

    fn is_available(&self) -> bool {
        self.config_path.is_file()
    }

    fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
        let text = match std::fs::read_to_string(&self.config_path) {
            Ok(t) => t,
            // Unavailable (gated by is_available) or unreadable (e.g. perms):
            // surface no hosts rather than failing the whole inventory.
            Err(_) => return Ok(Vec::new()),
        };

        let parsed = openssh_parse::parse(&text);
        let detail = self.config_path.display().to_string();

        let hosts = parsed
            .hosts
            .into_iter()
            .map(|ph| SshHost {
                id: SshHostId::new(SshSource::SystemConfig, ph.name.clone()),
                name: ph.name,
                host_name: ph.host_name,
                user: ph.user,
                port: ph.port,
                identity_file: ph.identity_file,
                // System config is never ProcMix-writable, regardless of the
                // block's own shape (often root-owned, machine policy).
                editable_params: false,
                editable_name: false,
                deletable: false,
                source_detail: detail.clone(),
                raw_text: ph.raw_text,
            })
            .collect();
        Ok(hosts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn write_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        path
    }

    #[test]
    fn unavailable_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = SystemConfigProvider::with_config_path(dir.path().join("ssh_config"));
        assert_eq!(p.source(), SshSource::SystemConfig);
        assert!(!p.is_available());
        assert!(p.list_hosts().unwrap().is_empty());
    }

    #[test]
    fn lists_hosts_as_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "ssh_config",
            "Host gitlab\n    HostName gitlab.example.com\n    User git\n    Port 2222\n",
        );
        let p = SystemConfigProvider::with_config_path(cfg);
        assert!(p.is_available());

        let hosts = p.list_hosts().unwrap();
        assert_eq!(hosts.len(), 1);
        let h = &hosts[0];
        assert_eq!(h.name, "gitlab");
        assert_eq!(h.host_name.as_deref(), Some("gitlab.example.com"));
        assert_eq!(h.user.as_deref(), Some("git"));
        assert_eq!(h.port, Some(2222));
        assert_eq!(h.id.source, SshSource::SystemConfig);
        // A clean literal block would be editable in the USER file, but from
        // the system source it must always be read-only.
        assert!(
            !h.editable_params,
            "system-config hosts must never be editable"
        );
    }

    #[test]
    fn forces_read_only_even_for_simple_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(dir.path(), "ssh_config", "Host simple\n    User u\n");
        let p = SystemConfigProvider::with_config_path(cfg);
        let hosts = p.list_hosts().unwrap();
        assert!(hosts.iter().all(|h| !h.editable_params));
    }

    #[test]
    fn global_defaults_before_any_host_are_ignored() {
        // A real system ssh_config often starts with global directives like
        // `Host *` or bare options — they must not crash or invent a host.
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "ssh_config",
            "    ForwardX11 no\nHost *\n    SendEnv LANG\nHost real\n    HostName r\n",
        );
        let p = SystemConfigProvider::with_config_path(cfg);
        let hosts = p.list_hosts().unwrap();
        // `Host *` is a wildcard (read-only); `real` is concrete but still
        // read-only from this source.
        assert!(hosts.iter().any(|h| h.name == "real"));
        assert!(hosts.iter().all(|h| !h.editable_params));
    }
}
