//! Plugin manifest (`plugin.json`) — the declarative description of a plugin.
//!
//! A manifest is pure DATA: it names the plugin, declares the API contract
//! version it targets, the permissions it requests, and what it contributes
//! (parsers, presets, content, event handlers, node kinds). Phase 1 only reads
//! and surfaces manifests — nothing here is executed. The `contributes` sections
//! are intentionally modelled as opaque counts at this stage; later phases
//! flesh out each section's concrete shape as they wire up the matching
//! extension point.

use serde::{Deserialize, Serialize};

/// The plugin-API contract version this build understands. A manifest whose
/// `apiVersion` has a different MAJOR is rejected by the registry (an
/// incompatible contract), mirroring the semver discipline documented in
/// `docs/ideas/plugin-system.md`.
pub const SUPPORTED_API_MAJOR: u32 = 1;

/// Permissions a plugin requests. All default to `false` (deny) so a manifest
/// that omits the section grants nothing — the opt-in model from the design
/// doc. Phase 1 only surfaces these for display/consent; enforcement arrives
/// with the integration phase.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginPermissions {
    pub network: bool,
    pub fs: bool,
    pub process: bool,
}

/// Bundled content (ready-made commands / workflows). Phase 1 surfaces only the
/// counts; the actual import lands in Phase 2 (content packs).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContributesContent {
    /// Number of ready-made commands the pack ships.
    pub commands: u32,
    /// Number of ready-made workflows the pack ships.
    pub workflows: u32,
}

/// What a plugin contributes, summarised as counts. Each later phase replaces
/// the matching `u32` with a concrete typed list as it implements that
/// extension point; keeping counts here lets the Plugins section show "what
/// this plugin adds" without depending on any not-yet-built section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Contributes {
    /// Output parsers (scenario A).
    pub parsers: u32,
    /// Command presets (scenario E).
    pub presets: u32,
    /// Event handlers / integrations (scenario C).
    pub event_handlers: u32,
    /// Custom workflow node kinds (scenario D).
    pub node_kinds: u32,
    /// Bundled content (scenario B).
    pub content: ContributesContent,
}

/// The parsed `plugin.json`. Crosses the IPC boundary verbatim, so every field
/// is camelCase on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Stable unique id (reverse-DNS by convention, e.g.
    /// `com.example.docker-toolkit`). Dedup key in the registry.
    pub id: String,
    pub name: String,
    pub version: String,
    /// Targeted plugin-API version as a semver string (e.g. `"1.0"`). Only the
    /// MAJOR is compatibility-checked; see [`api_major`].
    pub api_version: String,
    #[serde(default)]
    pub author: Option<String>,
    /// Operating systems this version supports, as canonical
    /// `std::env::consts::OS` values (`"linux"`, `"macos"`, `"windows"`).
    /// EMPTY or ABSENT means UNIVERSAL — the plugin works on any OS. A non-empty
    /// list restricts it to the listed systems. NOTE: OS-incompatibility is only
    /// a hint, not a hard block — a plugin's commands may target a remote host
    /// over SSH whose OS differs from the local one.
    #[serde(default)]
    pub os: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Optional list of human-readable changes this version introduces relative
    /// to the previous one. Surfaced on install / update / version-change so the
    /// user can see "what's new". Per-version: each version's manifest carries
    /// its own changelog. `None` when the author omitted it.
    #[serde(default)]
    pub changelog: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: PluginPermissions,
    #[serde(default)]
    pub contributes: Contributes,
}

impl PluginManifest {
    /// Parse the MAJOR component of `api_version`. Returns `None` when the
    /// string is not a recognisable `MAJOR` or `MAJOR.MINOR…` form, which the
    /// registry treats as an incompatible manifest.
    pub fn api_major(&self) -> Option<u32> {
        self.api_version
            .split('.')
            .next()
            .and_then(|major| major.trim().parse::<u32>().ok())
    }

    /// Whether this manifest's API major matches the build's supported major.
    pub fn is_api_compatible(&self) -> bool {
        self.api_major() == Some(SUPPORTED_API_MAJOR)
    }

    /// Whether this version is UNIVERSAL (declares no OS restriction).
    pub fn is_universal_os(&self) -> bool {
        self.os.is_empty()
    }

    /// Whether this version supports the given OS (a `std::env::consts::OS`
    /// value). Universal plugins support every OS. Comparison is
    /// case-insensitive so a manifest written `"Linux"` still matches.
    pub fn supports_os(&self, os: &str) -> bool {
        self.is_universal_os() || self.os.iter().any(|o| o.eq_ignore_ascii_case(os))
    }

    /// Whether this version supports the OS the app is currently running on.
    /// NOTE: this is advisory only — callers must NOT block install/use on a
    /// `false` result, since the plugin's commands may run on a remote host
    /// (e.g. over SSH) with a different OS.
    pub fn supports_current_os(&self) -> bool {
        self.supports_os(std::env::consts::OS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(api_version: &str) -> PluginManifest {
        PluginManifest {
            id: "com.example.test".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            api_version: api_version.into(),
            author: None,
            os: Vec::new(),
            description: None,
            changelog: None,
            permissions: PluginPermissions::default(),
            contributes: Contributes::default(),
        }
    }

    fn manifest_os(os: &[&str]) -> PluginManifest {
        let mut m = manifest("1.0");
        m.os = os.iter().map(|s| s.to_string()).collect();
        m
    }

    #[test]
    fn api_major_parses_major_minor() {
        assert_eq!(manifest("1.0").api_major(), Some(1));
        assert_eq!(manifest("2.5").api_major(), Some(2));
        assert_eq!(manifest("3").api_major(), Some(3));
    }

    #[test]
    fn api_major_rejects_garbage() {
        assert_eq!(manifest("").api_major(), None);
        assert_eq!(manifest("x.y").api_major(), None);
        assert_eq!(manifest("v1").api_major(), None);
    }

    #[test]
    fn compatibility_tracks_supported_major() {
        assert!(manifest("1.0").is_api_compatible());
        assert!(manifest("1.9").is_api_compatible());
        assert!(!manifest("2.0").is_api_compatible());
        assert!(!manifest("0.9").is_api_compatible());
    }

    #[test]
    fn permissions_default_to_deny() {
        let p = PluginPermissions::default();
        assert!(!p.network && !p.fs && !p.process);
    }

    #[test]
    fn manifest_deserializes_minimal_json() {
        // Only the required fields; optional sections default.
        let json = r#"{
            "id": "com.example.min",
            "name": "Minimal",
            "version": "0.1.0",
            "apiVersion": "1.0"
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.id, "com.example.min");
        assert_eq!(m.contributes.parsers, 0);
        assert!(!m.permissions.network);
        assert!(m.changelog.is_none());
        // No `os` declared → universal → supports every OS.
        assert!(m.is_universal_os());
        assert!(m.supports_os("linux"));
        assert!(m.supports_os("windows"));
        assert!(m.is_api_compatible());
    }

    #[test]
    fn universal_when_os_absent_or_empty() {
        // Empty list is universal.
        let m = manifest_os(&[]);
        assert!(m.is_universal_os());
        assert!(m.supports_os("linux") && m.supports_os("macos") && m.supports_os("windows"));
    }

    #[test]
    fn restricted_os_matches_only_listed() {
        let m = manifest_os(&["linux", "macos"]);
        assert!(!m.is_universal_os());
        assert!(m.supports_os("linux"));
        assert!(m.supports_os("macos"));
        assert!(!m.supports_os("windows"));
    }

    #[test]
    fn supports_os_is_case_insensitive() {
        let m = manifest_os(&["Windows"]);
        assert!(m.supports_os("windows"));
    }

    #[test]
    fn manifest_deserializes_full_json() {
        let json = r#"{
            "id": "com.example.full",
            "name": "Full",
            "version": "1.2.0",
            "apiVersion": "1.0",
            "author": "Acme",
            "os": ["linux", "macos"],
            "description": "Everything",
            "changelog": ["Added prune preset", "Fixed ps parsing"],
            "permissions": { "network": true, "fs": false, "process": true },
            "contributes": {
                "parsers": 2,
                "presets": 5,
                "eventHandlers": 1,
                "nodeKinds": 0,
                "content": { "commands": 10, "workflows": 3 }
            }
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.contributes.parsers, 2);
        assert_eq!(m.contributes.presets, 5);
        assert_eq!(m.contributes.event_handlers, 1);
        assert_eq!(m.contributes.content.commands, 10);
        assert_eq!(m.contributes.content.workflows, 3);
        assert!(m.permissions.network && m.permissions.process);
        assert!(!m.permissions.fs);
        assert_eq!(
            m.changelog.as_deref(),
            Some(
                &[
                    "Added prune preset".to_string(),
                    "Fixed ps parsing".to_string()
                ][..]
            )
        );
        assert_eq!(m.os, vec!["linux".to_string(), "macos".to_string()]);
        assert!(!m.is_universal_os());
        assert!(m.supports_os("linux") && !m.supports_os("windows"));
    }
}
