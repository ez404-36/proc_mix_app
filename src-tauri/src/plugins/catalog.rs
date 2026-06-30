//! Plugin catalog: the source of plugins a user can install.
//!
//! The catalog is SEPARATE from installed plugins (`plugins::discovery`):
//!   - catalog  = "what you can install" (multiple versions per plugin),
//!   - installed = "what is actually on disk and runs" (one version per plugin).
//!
//! A catalog is laid out by version:
//! ```text
//! <catalog-root>/<name>/v<MAJOR.MINOR.PATCH>/plugin.json (+ assets)
//! ```
//! `<name>` is a plugin folder; each `v<semver>` sub-folder is a self-contained,
//! installable version.
//!
//! Access goes through the [`CatalogSource`] trait so the storage backend is
//! pluggable. Phase 2 ships [`LocalCatalogSource`] (reads a local directory —
//! the bundled mock catalog, zero network). A future `GithubCatalogSource` can
//! implement the same trait (download from `proc_mix_app/plugins`) without
//! touching install logic or the UI.

use std::path::{Path, PathBuf};

use super::manifest::PluginManifest;
use super::semver::{self, Version};

/// One downloaded file of a plugin version: its relative path within the version
/// directory and its raw bytes. Install writes these verbatim under the
/// installed plugin directory.
#[derive(Debug, Clone)]
pub struct CatalogFile {
    /// Path relative to the version root (e.g. `plugin.json`, `parse.js`).
    pub rel_path: String,
    pub bytes: Vec<u8>,
}

/// A single installable version in the catalog: its parsed manifest plus the
/// version parsed from the folder name.
#[derive(Debug, Clone)]
pub struct CatalogVersion {
    pub version: Version,
    pub manifest: PluginManifest,
}

/// A plugin in the catalog: its name (folder) and all available versions,
/// sorted ascending by semver (latest is last).
#[derive(Debug, Clone)]
pub struct CatalogPlugin {
    /// Catalog folder name (the addressable handle for install).
    pub name: String,
    pub versions: Vec<CatalogVersion>,
}

impl CatalogPlugin {
    /// The latest (highest semver) version, if any.
    pub fn latest(&self) -> Option<&CatalogVersion> {
        self.versions.iter().max_by_key(|v| v.version)
    }
}

/// A source of installable plugins. Implementations resolve a catalog layout
/// (local dir now, GitHub later) into plugins, versions, and downloadable files.
pub trait CatalogSource {
    /// List every plugin in the catalog with its available versions (ascending
    /// by semver). A malformed plugin/version folder is skipped, not fatal.
    fn list(&self) -> Result<Vec<CatalogPlugin>, String>;

    /// Fetch all files of a specific plugin version, for installation. The
    /// returned set always includes `plugin.json`.
    fn fetch_version(&self, name: &str, version: Version) -> Result<Vec<CatalogFile>, String>;
}

/// Reject catalog identifiers that could escape the catalog root. A plugin
/// `name` is a single path segment: no separators, no `..`, non-empty.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

/// A catalog backed by a local directory (the bundled mock catalog in dev, or
/// any on-disk mirror). Zero network — ideal for local testing.
pub struct LocalCatalogSource {
    root: PathBuf,
}

impl LocalCatalogSource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Read and parse one version folder's manifest into a `CatalogVersion`.
    /// Returns `None` (skipped) when the folder name isn't `v<semver>` or the
    /// manifest is missing/invalid — a malformed version never sinks the list.
    fn read_version(version_dir: &Path, folder_name: &str) -> Option<CatalogVersion> {
        let version = Version::parse_folder(folder_name)?;
        let manifest_path = version_dir.join("plugin.json");
        let raw = std::fs::read_to_string(&manifest_path).ok()?;
        let manifest = serde_json::from_str::<PluginManifest>(&raw).ok()?;
        Some(CatalogVersion { version, manifest })
    }

    /// Collect a plugin's versions from its folder, sorted ascending by semver.
    fn read_plugin(plugin_dir: &Path, name: &str) -> Option<CatalogPlugin> {
        let entries = std::fs::read_dir(plugin_dir).ok()?;
        let mut versions: Vec<CatalogVersion> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            if let Some(v) = Self::read_version(&path, &folder) {
                versions.push(v);
            }
        }
        if versions.is_empty() {
            return None;
        }
        versions.sort_by_key(|v| v.version);
        Some(CatalogPlugin {
            name: name.to_string(),
            versions,
        })
    }
}

impl CatalogSource for LocalCatalogSource {
    fn list(&self) -> Result<Vec<CatalogPlugin>, String> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(e) => e,
            // An absent catalog root is not an error — it's an empty catalog.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("read catalog root {}: {e}", self.root.display())),
        };

        let mut plugins = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_safe_name(&name) {
                continue;
            }
            if let Some(plugin) = Self::read_plugin(&path, &name) {
                plugins.push(plugin);
            }
        }
        plugins.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(plugins)
    }

    fn fetch_version(&self, name: &str, version: Version) -> Result<Vec<CatalogFile>, String> {
        if !is_safe_name(name) {
            return Err(format!("unsafe plugin name: {name}"));
        }
        let version_dir = self.root.join(name).join(version.to_folder());
        if !version_dir.is_dir() {
            return Err(format!(
                "version {} of {name} not found in catalog",
                version.to_bare()
            ));
        }

        // Collect files recursively, preserving relative paths.
        let mut files = Vec::new();
        collect_files(&version_dir, &version_dir, &mut files)?;
        if !files.iter().any(|f| f.rel_path == "plugin.json") {
            return Err(format!(
                "version {} of {name} is missing plugin.json",
                version.to_bare()
            ));
        }
        Ok(files)
    }
}

/// Recursively gather every file under `dir` as `CatalogFile`s with paths
/// relative to `base`. Used to fetch all assets of a version, not just the
/// manifest.
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<CatalogFile>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(base, &path, out)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("relativize {}: {e}", path.display()))?
                .to_string_lossy()
                // Normalize Windows separators on the wire to forward slashes.
                .replace('\\', "/");
            let bytes =
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            out.push(CatalogFile {
                rel_path: rel,
                bytes,
            });
        }
    }
    Ok(())
}

/// Resolve the "latest" version of a catalog plugin by name. Convenience for the
/// default install action.
pub fn latest_version(plugins: &[CatalogPlugin], name: &str) -> Option<Version> {
    let plugin = plugins.iter().find(|p| p.name == name)?;
    semver::latest(
        &plugin
            .versions
            .iter()
            .map(|v| v.version)
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_version(root: &Path, name: &str, version: &str, extra_file: Option<(&str, &str)>) {
        let dir = root.join(name).join(format!("v{version}"));
        fs::create_dir_all(&dir).unwrap();
        let manifest = format!(
            r#"{{"id":"com.example.{name}","name":"{name}","version":"{version}","apiVersion":"1.0"}}"#
        );
        fs::write(dir.join("plugin.json"), manifest).unwrap();
        if let Some((fname, contents)) = extra_file {
            fs::write(dir.join(fname), contents).unwrap();
        }
    }

    #[test]
    fn lists_plugins_with_sorted_versions() {
        let tmp = tempfile::tempdir().unwrap();
        write_version(tmp.path(), "docker", "1.0.0", None);
        write_version(tmp.path(), "docker", "1.10.0", None);
        write_version(tmp.path(), "docker", "1.2.0", None);
        let src = LocalCatalogSource::new(tmp.path());
        let plugins = src.list().unwrap();
        assert_eq!(plugins.len(), 1);
        let docker = &plugins[0];
        // Ascending by semver: 1.0.0, 1.2.0, 1.10.0.
        let order: Vec<String> = docker
            .versions
            .iter()
            .map(|v| v.version.to_bare())
            .collect();
        assert_eq!(order, vec!["1.0.0", "1.2.0", "1.10.0"]);
        assert_eq!(docker.latest().unwrap().version.to_bare(), "1.10.0");
    }

    #[test]
    fn empty_or_missing_root_is_empty_catalog() {
        let tmp = tempfile::tempdir().unwrap();
        let src = LocalCatalogSource::new(tmp.path().join("nope"));
        assert!(src.list().unwrap().is_empty());
    }

    #[test]
    fn malformed_version_folder_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_version(tmp.path(), "docker", "1.0.0", None);
        // A non-semver folder is ignored.
        fs::create_dir_all(tmp.path().join("docker").join("nightly")).unwrap();
        let src = LocalCatalogSource::new(tmp.path());
        let plugins = src.list().unwrap();
        assert_eq!(plugins[0].versions.len(), 1);
    }

    #[test]
    fn plugin_with_no_valid_versions_is_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("ghost").join("notaversion")).unwrap();
        let src = LocalCatalogSource::new(tmp.path());
        assert!(src.list().unwrap().is_empty());
    }

    #[test]
    fn fetch_version_returns_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        write_version(tmp.path(), "docker", "1.2.0", Some(("parse.js", "// code")));
        let src = LocalCatalogSource::new(tmp.path());
        let files = src
            .fetch_version("docker", Version::parse("1.2.0").unwrap())
            .unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert!(names.contains(&"plugin.json"));
        assert!(names.contains(&"parse.js"));
    }

    #[test]
    fn fetch_unknown_version_errors() {
        let tmp = tempfile::tempdir().unwrap();
        write_version(tmp.path(), "docker", "1.0.0", None);
        let src = LocalCatalogSource::new(tmp.path());
        let err = src
            .fetch_version("docker", Version::parse("9.9.9").unwrap())
            .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn fetch_rejects_unsafe_name() {
        let tmp = tempfile::tempdir().unwrap();
        let src = LocalCatalogSource::new(tmp.path());
        assert!(src
            .fetch_version("../escape", Version::parse("1.0.0").unwrap())
            .is_err());
    }

    #[test]
    fn latest_version_helper() {
        let tmp = tempfile::tempdir().unwrap();
        write_version(tmp.path(), "docker", "1.0.0", None);
        write_version(tmp.path(), "docker", "2.0.0", None);
        let src = LocalCatalogSource::new(tmp.path());
        let plugins = src.list().unwrap();
        assert_eq!(
            latest_version(&plugins, "docker").unwrap().to_bare(),
            "2.0.0"
        );
        assert!(latest_version(&plugins, "nonexistent").is_none());
    }
}
