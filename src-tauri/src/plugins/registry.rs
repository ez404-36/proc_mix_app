//! Aggregates discovered plugins into the deduplicated, status-annotated list
//! the UI shows: computes per-plugin status (loaded / disabled / incompatible
//! / error), deduplicates by manifest `id` (core before community before
//! user), and isolates per-plugin failures so one broken manifest never
//! sinks the list.
//!
//! Phase 1 does NOT execute any plugin; it only describes and orders them. The
//! enabled/disabled flag is supplied by the caller (persisted separately) and
//! merged in here.

use std::collections::HashSet;

use super::discovery::{DiscoveredPlugin, PluginSource};
use super::manifest::{Contributes, PluginManifest, PluginPermissions};

/// Lifecycle status of a single plugin, surfaced to the UI so it can explain
/// why a plugin is (or isn't) active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    /// Manifest parsed, API-compatible, and enabled — active.
    Enabled,
    /// Manifest parsed and compatible, but the user turned it off.
    Disabled,
    /// Manifest parsed but targets an incompatible API major. Unusable.
    Incompatible,
    /// Enabled and API-compatible, but the local OS is NOT in the plugin's
    /// declared `os` list. This is ADVISORY, not a block — the plugin still
    /// works (its commands may target a remote host over SSH). The UI surfaces
    /// it as a "not for this OS" hint rather than disabling anything.
    OsIncompatible,
    /// Manifest missing/unreadable/invalid — failed to load.
    Error,
}

/// A plugin as presented to the UI: identity, what it contributes, its
/// permissions, source root, and resolved status. This is the IPC DTO, so every
/// field is camelCase on the wire.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    /// Manifest id, or — for an unparseable manifest — the directory name, so
    /// the row still has a stable handle to address (enable/disable/remove).
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Per-version list of changes ("what's new"), when the manifest provides it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog: Option<Vec<String>>,
    pub source: PluginSource,
    pub status: PluginStatus,
    pub permissions: PluginPermissions,
    pub contributes: Contributes,
    /// Declared target OSes (`std::env::consts::OS` values). Empty = universal
    /// (any OS). Surfaced so the UI can show which systems the plugin targets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub os: Vec<String>,
    /// Whether the plugin supports the OS the app is running on. `true` for
    /// universal plugins. Advisory — a `false` value never blocks use.
    pub os_compatible: bool,
    /// Absolute path to the plugin directory (handle for remove; display).
    pub dir: String,
    /// Why the plugin failed to load, when `status == Error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Fallback id for a plugin whose manifest didn't parse: the directory name (so
/// two broken plugins in different dirs stay distinct and addressable).
fn fallback_id(plugin: &DiscoveredPlugin) -> String {
    plugin
        .dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| plugin.dir.to_string_lossy().into_owned())
}

/// Resolve the status of a single discovered plugin. `is_enabled` answers
/// "has the user enabled this id" (defaulting to enabled for unknown ids is the
/// caller's decision — see [`aggregate`]).
fn resolve_status(manifest: &PluginManifest, is_enabled: bool) -> PluginStatus {
    // API incompatibility is fundamental (the plugin is unusable) and wins.
    if !manifest.is_api_compatible() {
        return PluginStatus::Incompatible;
    }
    // A disabled plugin reports Disabled regardless of OS — the user's choice
    // takes priority over an advisory OS hint.
    if !is_enabled {
        return PluginStatus::Disabled;
    }
    // Enabled + API-OK: flag an OS mismatch, but stay "on" (non-blocking — the
    // plugin may target a remote host of a different OS).
    if !manifest.supports_current_os() {
        return PluginStatus::OsIncompatible;
    }
    PluginStatus::Enabled
}

/// Build a `PluginView` for one discovered plugin given its enabled flag.
fn to_view(plugin: &DiscoveredPlugin, is_enabled: bool) -> PluginView {
    match &plugin.manifest {
        Some(m) => PluginView {
            id: m.id.clone(),
            name: m.name.clone(),
            version: Some(m.version.clone()),
            api_version: Some(m.api_version.clone()),
            author: m.author.clone(),
            description: m.description.clone(),
            changelog: m.changelog.clone(),
            source: plugin.source,
            status: resolve_status(m, is_enabled),
            permissions: m.permissions.clone(),
            contributes: m.contributes.clone(),
            os: m.os.clone(),
            os_compatible: m.supports_current_os(),
            dir: plugin.dir.to_string_lossy().into_owned(),
            error: None,
        },
        None => PluginView {
            id: fallback_id(plugin),
            name: fallback_id(plugin),
            version: None,
            api_version: None,
            author: None,
            description: None,
            changelog: None,
            source: plugin.source,
            status: PluginStatus::Error,
            permissions: PluginPermissions::default(),
            contributes: Contributes::default(),
            os: Vec::new(),
            os_compatible: true,
            dir: plugin.dir.to_string_lossy().into_owned(),
            error: plugin.error.clone(),
        },
    }
}

/// Aggregate discovered plugins into the deduplicated view list.
///
/// `is_enabled(id)` answers whether the user has the plugin with that id turned
/// on. Dedup is by `id`, first occurrence wins (discovery already orders
/// core → community → user). Plugins that failed to parse are kept (as `Error`
/// rows) and deduped by their fallback id so duplicates of a broken dir don't
/// pile up.
pub fn aggregate(
    discovered: &[DiscoveredPlugin],
    is_enabled: impl Fn(&str) -> bool,
) -> Vec<PluginView> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut views: Vec<PluginView> = Vec::new();

    for plugin in discovered {
        let id = match &plugin.manifest {
            Some(m) => m.id.clone(),
            None => fallback_id(plugin),
        };
        // First occurrence wins (trust order). A later root re-declaring the
        // same id is ignored — the higher-trust definition stands.
        if !seen.insert(id.clone()) {
            continue;
        }
        // An errored or incompatible plugin can't be "on"; only a parsed,
        // compatible manifest consults the enabled flag.
        let enabled = plugin
            .manifest
            .as_ref()
            .map(|_| is_enabled(&id))
            .unwrap_or(false);
        views.push(to_view(plugin, enabled));
    }

    views
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn manifest(id: &str, api: &str) -> PluginManifest {
        PluginManifest {
            id: id.into(),
            name: format!("Name {id}"),
            version: "1.0.0".into(),
            api_version: api.into(),
            author: None,
            os: Vec::new(),
            description: None,
            changelog: None,
            permissions: PluginPermissions::default(),
            contributes: Contributes::default(),
        }
    }

    /// A discovered plugin whose manifest restricts to the given OS list.
    fn ok_os(id: &str, os: &[&str]) -> DiscoveredPlugin {
        let mut m = manifest(id, "1.0");
        m.os = os.iter().map(|s| s.to_string()).collect();
        DiscoveredPlugin {
            source: PluginSource::User,
            dir: PathBuf::from(format!("/plugins/{id}")),
            manifest: Some(m),
            error: None,
        }
    }

    fn ok(source: PluginSource, id: &str, api: &str) -> DiscoveredPlugin {
        DiscoveredPlugin {
            source,
            dir: PathBuf::from(format!("/plugins/{id}")),
            manifest: Some(manifest(id, api)),
            error: None,
        }
    }

    fn broken(source: PluginSource, dir_name: &str) -> DiscoveredPlugin {
        DiscoveredPlugin {
            source,
            dir: PathBuf::from(format!("/plugins/{dir_name}")),
            manifest: None,
            error: Some("parse error".into()),
        }
    }

    #[test]
    fn enabled_compatible_plugin_is_enabled() {
        let d = vec![ok(PluginSource::User, "a", "1.0")];
        let views = aggregate(&d, |_| true);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].status, PluginStatus::Enabled);
    }

    #[test]
    fn disabled_flag_is_respected() {
        let d = vec![ok(PluginSource::User, "a", "1.0")];
        let views = aggregate(&d, |_| false);
        assert_eq!(views[0].status, PluginStatus::Disabled);
    }

    #[test]
    fn incompatible_major_overrides_enabled() {
        let d = vec![ok(PluginSource::User, "a", "2.0")];
        // Even though "enabled", an incompatible API makes it Incompatible.
        let views = aggregate(&d, |_| true);
        assert_eq!(views[0].status, PluginStatus::Incompatible);
    }

    #[test]
    fn broken_manifest_becomes_error_row() {
        let d = vec![broken(PluginSource::User, "bad")];
        let views = aggregate(&d, |_| true);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].status, PluginStatus::Error);
        assert_eq!(views[0].id, "bad");
        assert!(views[0].error.is_some());
    }

    #[test]
    fn dedup_by_id_first_occurrence_wins() {
        // Two installed dirs declaring the same id: first occurrence wins, the
        // duplicate is dropped (defends against a stray copy).
        let mut first = ok(PluginSource::User, "dup", "1.0");
        first.dir = PathBuf::from("/plugins/first");
        let mut second = ok(PluginSource::User, "dup", "1.0");
        second.dir = PathBuf::from("/plugins/second");
        let d = vec![first, second];
        let views = aggregate(&d, |_| true);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].dir, "/plugins/first");
    }

    #[test]
    fn one_broken_plugin_does_not_drop_the_healthy_one() {
        let d = vec![
            ok(PluginSource::User, "good", "1.0"),
            broken(PluginSource::User, "bad"),
        ];
        let views = aggregate(&d, |_| true);
        assert_eq!(views.len(), 2);
        assert_eq!(
            views
                .iter()
                .filter(|v| v.status == PluginStatus::Enabled)
                .count(),
            1
        );
        assert_eq!(
            views
                .iter()
                .filter(|v| v.status == PluginStatus::Error)
                .count(),
            1
        );
    }

    #[test]
    fn enabled_flag_keyed_by_id() {
        let d = vec![
            ok(PluginSource::User, "on", "1.0"),
            ok(PluginSource::User, "off", "1.0"),
        ];
        let views = aggregate(&d, |id| id == "on");
        let on = views.iter().find(|v| v.id == "on").unwrap();
        let off = views.iter().find(|v| v.id == "off").unwrap();
        assert_eq!(on.status, PluginStatus::Enabled);
        assert_eq!(off.status, PluginStatus::Disabled);
    }

    /// An OS not equal to whatever the test currently runs on — so the
    /// restriction reliably excludes the local OS.
    fn a_foreign_os() -> &'static str {
        if std::env::consts::OS == "linux" {
            "windows"
        } else {
            "linux"
        }
    }

    #[test]
    fn enabled_but_foreign_os_is_os_incompatible() {
        let d = vec![ok_os("foreign", &[a_foreign_os()])];
        let views = aggregate(&d, |_| true);
        // Non-blocking: it's surfaced as OsIncompatible (still effectively on).
        assert_eq!(views[0].status, PluginStatus::OsIncompatible);
        assert!(!views[0].os_compatible);
        assert_eq!(views[0].os, vec![a_foreign_os().to_string()]);
    }

    #[test]
    fn enabled_with_current_os_is_enabled() {
        let d = vec![ok_os("native", &[std::env::consts::OS])];
        let views = aggregate(&d, |_| true);
        assert_eq!(views[0].status, PluginStatus::Enabled);
        assert!(views[0].os_compatible);
    }

    #[test]
    fn universal_plugin_is_os_compatible() {
        let d = vec![ok(PluginSource::User, "universal", "1.0")];
        let views = aggregate(&d, |_| true);
        assert_eq!(views[0].status, PluginStatus::Enabled);
        assert!(views[0].os_compatible);
        assert!(views[0].os.is_empty());
    }

    #[test]
    fn disabled_takes_priority_over_os_mismatch() {
        // A disabled, foreign-OS plugin reports Disabled (user choice wins).
        let d = vec![ok_os("foreign", &[a_foreign_os()])];
        let views = aggregate(&d, |_| false);
        assert_eq!(views[0].status, PluginStatus::Disabled);
    }

    #[test]
    fn api_incompat_takes_priority_over_os_mismatch() {
        // Incompatible API + foreign OS → Incompatible (the fundamental block).
        let mut d = ok_os("both", &[a_foreign_os()]);
        if let Some(m) = d.manifest.as_mut() {
            m.api_version = "2.0".into();
        }
        let views = aggregate(&[d], |_| true);
        assert_eq!(views[0].status, PluginStatus::Incompatible);
    }
}
