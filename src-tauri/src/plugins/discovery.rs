//! Plugin discovery: find `plugin.json` manifests of INSTALLED plugins.
//!
//! Installed plugins live under a single root — `<app-data>/plugins/<name>/` —
//! and are all user-installed (downloaded from the catalog; see
//! `plugins::catalog` / `plugins::install`). There is no bundled/core/community
//! root anymore: a fresh install has zero plugins.
//!
//! A "plugin" on disk is a directory containing a `plugin.json`. Discovery walks
//! the root's immediate sub-directories, reads each manifest, and reports a
//! [`DiscoveredPlugin`] per directory — carrying either the parsed manifest or a
//! per-plugin error. A single unreadable/invalid manifest never aborts the scan
//! (mirrors the per-source isolation in `core/ssh/registry.rs`).
//!
//! Discovery does NOT decide compatibility or enabled-state — that is the
//! registry's job. It only answers "what is installed, and could we parse it".

use std::path::{Path, PathBuf};

use super::manifest::PluginManifest;

/// Where an installed plugin came from. With the catalog model every installed
/// plugin is user-installed; the enum is retained (single variant) so the IPC
/// `source` field stays stable for the frontend and leaves room for future
/// provenance (e.g. a sideloaded source) without a breaking change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginSource {
    /// Installed by the user (under `<app-data>/plugins`).
    User,
}

/// One installed plugin directory: its source, directory path, and parse
/// outcome. `manifest` is `Some` on success; `error` is `Some` when the manifest
/// was missing/unreadable/invalid. Exactly one of the two is set.
#[derive(Debug, Clone)]
pub struct DiscoveredPlugin {
    pub source: PluginSource,
    pub dir: PathBuf,
    pub manifest: Option<PluginManifest>,
    pub error: Option<String>,
}

/// The manifest file name expected in every plugin directory.
const MANIFEST_FILE: &str = "plugin.json";

/// Read and parse a single plugin directory's manifest. Returns a
/// `DiscoveredPlugin` whose `error` explains any failure (missing file, IO
/// error, invalid JSON) so the UI can show "failed to load" rather than the
/// plugin silently vanishing.
fn read_plugin_dir(dir: &Path) -> DiscoveredPlugin {
    let manifest_path = dir.join(MANIFEST_FILE);
    let outcome = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))
        .and_then(|raw| {
            serde_json::from_str::<PluginManifest>(&raw)
                .map_err(|e| format!("parse {}: {e}", manifest_path.display()))
        });

    match outcome {
        Ok(manifest) => DiscoveredPlugin {
            source: PluginSource::User,
            dir: dir.to_path_buf(),
            manifest: Some(manifest),
            error: None,
        },
        Err(error) => DiscoveredPlugin {
            source: PluginSource::User,
            dir: dir.to_path_buf(),
            manifest: None,
            error: Some(error),
        },
    }
}

/// Discover every installed plugin under the user plugins root.
///
/// A missing root is normal (a fresh install has no plugins) and yields an empty
/// list. An unreadable root is logged and also yields empty — discovery never
/// propagates a root-level error as fatal. Each sub-directory that holds a
/// `plugin.json` becomes a `DiscoveredPlugin`; sub-directories without one are
/// skipped silently (they are not plugins).
pub fn discover(root: &Path) -> Vec<DiscoveredPlugin> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => {
            // Absent root is the common case (no plugins installed yet); only a
            // genuinely unexpected error is worth a warning.
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(root = %root.display(), "scan plugin root: {e}");
            }
            return Vec::new();
        }
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Only treat a sub-directory as a plugin when it actually has a
        // manifest; skip unrelated directories quietly.
        if path.join(MANIFEST_FILE).is_file() {
            found.push(read_plugin_dir(&path));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_plugin(root: &Path, dir_name: &str, manifest_json: &str) {
        let dir = root.join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), manifest_json).unwrap();
    }

    const VALID: &str = r#"{
        "id": "com.example.valid",
        "name": "Valid",
        "version": "1.0.0",
        "apiVersion": "1.0"
    }"#;

    #[test]
    fn scans_valid_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "valid", VALID);
        let found = discover(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, PluginSource::User);
        assert!(found[0].error.is_none());
        assert_eq!(found[0].manifest.as_ref().unwrap().id, "com.example.valid");
    }

    #[test]
    fn invalid_manifest_is_reported_not_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "broken", "{ not json");
        let found = discover(tmp.path());
        assert_eq!(found.len(), 1);
        assert!(found[0].manifest.is_none());
        assert!(found[0].error.as_ref().unwrap().contains("parse"));
    }

    #[test]
    fn one_broken_plugin_does_not_sink_the_others() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "good", VALID);
        write_plugin(tmp.path(), "bad", "nonsense");
        let mut found = discover(tmp.path());
        found.sort_by(|a, b| a.dir.cmp(&b.dir));
        assert_eq!(found.len(), 2);
        // Exactly one parsed, exactly one errored.
        assert_eq!(found.iter().filter(|p| p.manifest.is_some()).count(), 1);
        assert_eq!(found.iter().filter(|p| p.error.is_some()).count(), 1);
    }

    #[test]
    fn dir_without_manifest_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("not-a-plugin")).unwrap();
        let found = discover(tmp.path());
        assert!(found.is_empty());
    }

    #[test]
    fn missing_root_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let absent = tmp.path().join("does-not-exist");
        let found = discover(&absent);
        assert!(found.is_empty());
    }
}
