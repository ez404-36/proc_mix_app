//! Plugin system: catalog, install, discovery, lifecycle, and (later) sandboxing.
//!
//! Two distinct concepts:
//!   - **catalog** ([`catalog`]) — what the user CAN install, with multiple
//!     versions per plugin. Backed by a pluggable [`catalog::CatalogSource`]
//!     (local dir now; GitHub later).
//!   - **installed** ([`discovery`]) — what is actually on disk under
//!     `<app-data>/plugins/<name>/` and runs. One version per plugin; a fresh
//!     install has zero plugins.
//!
//! Install / update / rollback are the single [`install::install_version`]
//! operation (write a version into the installed dir, replacing what was there).
//! Nothing here EXECUTES plugin code — that arrives in later phases (parsers,
//! presets, integrations, nodes). See `docs/ideas/plugin-system.md` and
//! `docs/plans/plugins/`.

pub mod catalog;
pub mod discovery;
pub mod install;
pub mod manifest;
pub mod registry;
pub mod semver;

use std::path::{Path, PathBuf};

pub use catalog::{CatalogPlugin, CatalogSource, LocalCatalogSource};
pub use discovery::PluginSource;
pub use manifest::{Contributes, PluginManifest, PluginPermissions, SUPPORTED_API_MAJOR};
pub use registry::{PluginStatus, PluginView};
pub use semver::Version;

/// Where the plugin catalog (installable plugins) is read from.
///
/// Resolved from the `PROCMIX_PLUGIN_CATALOG` env var with build-aware defaults
/// (see [`resolve_catalog_location`]). A `Remote` URL is reserved for the future
/// GitHub-backed source and is not yet wired — [`PluginRoots::catalog_source`]
/// surfaces a clear error for it rather than silently doing nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogLocation {
    /// A local versioned catalog directory (`<dir>/<name>/v<semver>/`).
    Local(PathBuf),
    /// A remote catalog URL (reserved; not implemented in this phase).
    Remote(String),
}

/// The plugin directories for the current install.
///
/// `catalog` is where installable plugins come from (env-overridable; defaults
/// to the local mock catalog in dev). `installed` is the writable per-user
/// directory under app-data where installed plugins live. A missing local
/// catalog or installed dir is fine — both are treated as "empty".
#[derive(Debug, Clone)]
pub struct PluginRoots {
    /// Source of installable plugins.
    pub catalog: CatalogLocation,
    /// Installed plugins (`<app-data>/plugins`).
    pub installed: PathBuf,
}

/// The env var that overrides the catalog source. A filesystem path selects a
/// local catalog; an `http(s)://` URL selects a remote one (reserved).
pub const CATALOG_ENV: &str = "PROCMIX_PLUGIN_CATALOG";

/// Resolve the catalog location from the environment and build profile.
///
/// Order:
///   1. `$PROCMIX_PLUGIN_CATALOG` if set & non-empty — a URL → `Remote`,
///      otherwise a path → `Local` (relative paths resolve against
///      `base_dir`, which the caller sets to the app working directory).
///   2. debug build → the local mock catalog at `<dev_root>/.mocks/plugins`.
///   3. release build → the bundled catalog at `<resource>/plugins/catalog`
///      (currently empty; the remote/GitHub source lands later).
///
/// `dev_root` is the `app/` directory (resolved from `CARGO_MANIFEST_DIR` by the
/// caller); `resource_dir` is Tauri's bundled-resource directory.
pub fn resolve_catalog_location(
    env_value: Option<&str>,
    dev_root: &Path,
    resource_dir: &Path,
) -> CatalogLocation {
    if let Some(raw) = env_value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                return CatalogLocation::Remote(trimmed.to_string());
            }
            let path = Path::new(trimmed);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                dev_root.join(path)
            };
            return CatalogLocation::Local(resolved);
        }
    }

    if cfg!(debug_assertions) {
        CatalogLocation::Local(dev_root.join(".mocks").join("plugins"))
    } else {
        CatalogLocation::Local(resource_dir.join("plugins").join("catalog"))
    }
}

impl PluginRoots {
    /// Build the roots, resolving the catalog from `PROCMIX_PLUGIN_CATALOG` and
    /// the build profile. `dev_root` is the `app/` directory (for relative paths
    /// and the dev mock default); `resource_dir` is the bundled-resource dir;
    /// `app_data_dir` hosts installed plugins.
    pub fn new(dev_root: &Path, resource_dir: &Path, app_data_dir: &Path) -> Self {
        let env_value = std::env::var(CATALOG_ENV).ok();
        let catalog = resolve_catalog_location(env_value.as_deref(), dev_root, resource_dir);
        Self {
            catalog,
            installed: install::plugins_root(app_data_dir),
        }
    }

    /// Construct directly from a resolved location (tests / explicit wiring).
    pub fn from_parts(catalog: CatalogLocation, installed: PathBuf) -> Self {
        Self { catalog, installed }
    }

    /// A `LocalCatalogSource` over the catalog directory.
    ///
    /// Errors for a `Remote` location — the GitHub-backed source is not wired
    /// yet, so we fail loudly rather than pretend the catalog is empty.
    pub fn catalog_source(&self) -> Result<LocalCatalogSource, String> {
        match &self.catalog {
            CatalogLocation::Local(dir) => Ok(LocalCatalogSource::new(dir.clone())),
            CatalogLocation::Remote(url) => {
                Err(format!("remote plugin catalog is not supported yet: {url}"))
            }
        }
    }
}

/// Discover and aggregate INSTALLED plugins, applying the user's disabled set.
/// Pure over its inputs (filesystem only) so it is straightforward to test; the
/// command layer supplies `disabled` from `storage::plugin_state`.
pub fn load_plugins(
    roots: &PluginRoots,
    disabled: &std::collections::HashSet<String>,
) -> Vec<PluginView> {
    let discovered = discovery::discover(&roots.installed);
    registry::aggregate(&discovered, |id| !disabled.contains(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    fn write_installed(root: &Path, dir: &str, id: &str) {
        let dir = root.join(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            format!(r#"{{"id":"{id}","name":"{id}","version":"1.0.0","apiVersion":"1.0"}}"#),
        )
        .unwrap();
    }

    fn roots_with_installed(installed: PathBuf) -> PluginRoots {
        PluginRoots::from_parts(
            CatalogLocation::Local(PathBuf::from("/nonexistent")),
            installed,
        )
    }

    #[test]
    fn load_plugins_discovers_installed_and_applies_disabled_set() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_with_installed(tmp.path().join("plugins"));

        write_installed(&roots.installed, "a", "com.a");
        write_installed(&roots.installed, "b", "com.b");

        let mut disabled = HashSet::new();
        disabled.insert("com.b".to_string());

        let views = load_plugins(&roots, &disabled);
        assert_eq!(views.len(), 2);
        let a = views.iter().find(|v| v.id == "com.a").unwrap();
        let b = views.iter().find(|v| v.id == "com.b").unwrap();
        assert_eq!(a.status, PluginStatus::Enabled);
        assert_eq!(b.status, PluginStatus::Disabled);
    }

    #[test]
    fn load_plugins_on_empty_install_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_with_installed(tmp.path().join("plugins"));
        let views = load_plugins(&roots, &HashSet::new());
        assert!(views.is_empty());
    }

    #[test]
    fn env_path_overrides_to_local_catalog() {
        let dev = Path::new("/dev/root");
        let res = Path::new("/res");
        // Absolute path → used verbatim.
        assert_eq!(
            resolve_catalog_location(Some("/abs/catalog"), dev, res),
            CatalogLocation::Local(PathBuf::from("/abs/catalog"))
        );
        // Relative path → resolved against dev_root.
        assert_eq!(
            resolve_catalog_location(Some("./.mocks/plugins"), dev, res),
            CatalogLocation::Local(dev.join("./.mocks/plugins"))
        );
    }

    #[test]
    fn env_url_overrides_to_remote() {
        let dev = Path::new("/dev/root");
        let res = Path::new("/res");
        assert_eq!(
            resolve_catalog_location(Some("https://example.com/catalog"), dev, res),
            CatalogLocation::Remote("https://example.com/catalog".to_string())
        );
    }

    #[test]
    fn empty_or_unset_env_falls_through_to_default() {
        let dev = Path::new("/dev/root");
        let res = Path::new("/res");
        // Both unset and empty/whitespace behave the same (build-aware default).
        let unset = resolve_catalog_location(None, dev, res);
        let empty = resolve_catalog_location(Some("   "), dev, res);
        assert_eq!(unset, empty);
        // In a debug test build the default is the local mock catalog.
        assert_eq!(
            unset,
            CatalogLocation::Local(dev.join(".mocks").join("plugins"))
        );
    }

    #[test]
    fn remote_catalog_source_errors() {
        let roots = PluginRoots::from_parts(
            CatalogLocation::Remote("https://example.com".into()),
            PathBuf::from("/installed"),
        );
        assert!(roots.catalog_source().is_err());
    }
}

#[cfg(test)]
mod bundled_catalog {
    //! Regression test over the shipped mock CATALOG under `../plugins/catalog`.
    //! Keeps the versioned `plugin.json` fixtures valid and exercises the
    //! end-to-end flow: list catalog → fetch latest version → install →
    //! discover as installed. Skips gracefully when the source-tree catalog is
    //! absent (e.g. a packaged-only checkout).

    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn catalog_root() -> Option<PathBuf> {
        // The mock catalog lives at `app/.mocks/plugins`; the crate is at
        // `app/src-tauri`, so go up one level.
        let crate_dir = env!("CARGO_MANIFEST_DIR");
        let root = PathBuf::from(crate_dir)
            .join("..")
            .join(".mocks")
            .join("plugins");
        root.is_dir().then_some(root)
    }

    #[test]
    fn lists_versioned_catalog_with_latest() {
        let Some(root) = catalog_root() else { return };
        let src = LocalCatalogSource::new(&root);
        let plugins = src.list().unwrap();

        let docker = plugins
            .iter()
            .find(|p| p.name == "docker-toolkit")
            .expect("docker-toolkit in catalog");
        // Multiple versions, latest resolves to the highest semver.
        assert!(docker.versions.len() >= 2);
        assert_eq!(docker.latest().unwrap().version.to_bare(), "1.2.0");
    }

    #[test]
    fn install_latest_then_discover_as_installed() {
        let Some(root) = catalog_root() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let installed_root = tmp.path().join("plugins");

        let src = LocalCatalogSource::new(&root);
        let plugins = src.list().unwrap();
        let latest = catalog::latest_version(&plugins, "docker-toolkit").unwrap();
        let files = src.fetch_version("docker-toolkit", latest).unwrap();

        let manifest =
            install::install_version(&installed_root, "docker-toolkit", latest, &files).unwrap();
        assert_eq!(manifest.version, "1.2.0");
        // The extra asset of v1.2.0 was installed alongside the manifest.
        assert!(installed_root
            .join("docker-toolkit")
            .join("parse.js")
            .is_file());

        // Now discovery sees it as an installed, enabled plugin.
        let roots = PluginRoots::from_parts(CatalogLocation::Local(root), installed_root);
        let views = load_plugins(&roots, &HashSet::new());
        let docker = views
            .iter()
            .find(|v| v.id == "app.procmix.docker-toolkit")
            .expect("installed docker-toolkit");
        assert_eq!(docker.status, PluginStatus::Enabled);
        assert_eq!(docker.version.as_deref(), Some("1.2.0"));
    }

    #[test]
    fn rollback_replaces_with_older_version() {
        let Some(root) = catalog_root() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let installed_root = tmp.path().join("plugins");
        let src = LocalCatalogSource::new(&root);

        // Install latest, then "roll back" to an older version — same operation.
        let latest = Version::parse("1.2.0").unwrap();
        let older = Version::parse("1.0.0").unwrap();
        let latest_files = src.fetch_version("docker-toolkit", latest).unwrap();
        install::install_version(&installed_root, "docker-toolkit", latest, &latest_files).unwrap();
        let older_files = src.fetch_version("docker-toolkit", older).unwrap();
        let m = install::install_version(&installed_root, "docker-toolkit", older, &older_files)
            .unwrap();

        assert_eq!(m.version, "1.0.0");
        // v1.0.0 has no parse.js, so the replacement is clean (no stale asset).
        assert!(!installed_root
            .join("docker-toolkit")
            .join("parse.js")
            .exists());
    }
}
