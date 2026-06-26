//! Installing a catalog plugin version into the user plugins directory.
//!
//! Install is the single operation behind install / update / rollback — they all
//! "write version X into `<app-data>/plugins/<name>/`, replacing whatever was
//! there". It is ATOMIC: files are staged in a temp directory next to the target
//! and only swapped in once fully written, so an interrupted install never
//! leaves a half-written plugin (the previous version, if any, survives).
//!
//! Phase 2 installs DATA only — no plugin code is executed here. The manifest is
//! validated (parse + API-major + version matches the requested folder) before
//! anything is written.

use std::path::{Path, PathBuf};

use super::catalog::CatalogFile;
use super::manifest::PluginManifest;
use super::semver::Version;

/// Reject a plugin name that could escape the install root (path traversal).
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
}

/// Reject a fetched file's relative path that could escape the plugin directory
/// (absolute, `..` segment, or empty). Defence-in-depth: the catalog source
/// already produces in-tree relative paths, but install never trusts them.
fn is_safe_rel_path(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return false;
    }
    p.components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

/// Validate the fetched files' `plugin.json` against the requested name/version.
/// Returns the parsed manifest on success. Rejects a version-folder/manifest
/// mismatch or an incompatible API major (so an install can't silently land a
/// plugin that discovery would then flag as incompatible).
fn validate(files: &[CatalogFile], version: Version) -> Result<PluginManifest, String> {
    let manifest_file = files
        .iter()
        .find(|f| f.rel_path == "plugin.json")
        .ok_or("fetched version is missing plugin.json")?;
    let manifest: PluginManifest = serde_json::from_slice(&manifest_file.bytes)
        .map_err(|e| format!("parse plugin.json: {e}"))?;

    if manifest.version != version.to_bare() {
        return Err(format!(
            "manifest version {} does not match catalog folder {}",
            manifest.version,
            version.to_folder()
        ));
    }
    if !manifest.is_api_compatible() {
        return Err(format!(
            "plugin targets incompatible apiVersion {}",
            manifest.api_version
        ));
    }
    Ok(manifest)
}

/// Write all files into `dest`, creating parent directories as needed.
fn write_files(dest: &Path, files: &[CatalogFile]) -> Result<(), String> {
    for file in files {
        if !is_safe_rel_path(&file.rel_path) {
            return Err(format!("unsafe file path in version: {}", file.rel_path));
        }
        let target = dest.join(&file.rel_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&target, &file.bytes)
            .map_err(|e| format!("write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// Install `files` (a fetched catalog version) as plugin `name` under
/// `plugins_root` (the `<app-data>/plugins` directory). Replaces any existing
/// install of the same name. Returns the installed manifest.
///
/// Atomicity: stages into `<root>/.<name>.tmp`, then swaps directories so the
/// live `<root>/<name>` is only ever the old version or the fully-written new
/// one — never a partial mix.
pub fn install_version(
    plugins_root: &Path,
    name: &str,
    version: Version,
    files: &[CatalogFile],
) -> Result<PluginManifest, String> {
    if !is_safe_name(name) {
        return Err(format!("unsafe plugin name: {name}"));
    }
    let manifest = validate(files, version)?;

    std::fs::create_dir_all(plugins_root)
        .map_err(|e| format!("create plugins root {}: {e}", plugins_root.display()))?;

    let target = plugins_root.join(name);
    let staging = plugins_root.join(format!(".{name}.tmp"));
    let backup = plugins_root.join(format!(".{name}.bak"));

    // Clean any leftovers from a previously-interrupted install.
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&backup);

    // 1. Stage the new version fully into a temp dir.
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("create staging {}: {e}", staging.display()))?;
    if let Err(e) = write_files(&staging, files) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // 2. Swap: move the old version aside (if present), move staging into place,
    //    then drop the old one. If the final rename fails, restore the backup.
    let had_existing = target.exists();
    if had_existing {
        std::fs::rename(&target, &backup)
            .map_err(|e| format!("back up existing {}: {e}", target.display()))?;
    }
    match std::fs::rename(&staging, &target) {
        Ok(()) => {
            if had_existing {
                let _ = std::fs::remove_dir_all(&backup);
            }
            Ok(manifest)
        }
        Err(e) => {
            // Roll back: restore the previous version, discard staging.
            if had_existing {
                let _ = std::fs::rename(&backup, &target);
            }
            let _ = std::fs::remove_dir_all(&staging);
            Err(format!("install {}: {e}", target.display()))
        }
    }
}

/// Convenience handle to the user plugins root (`<app-data>/plugins`).
pub fn plugins_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("plugins")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel: &str, contents: &str) -> CatalogFile {
        CatalogFile {
            rel_path: rel.to_string(),
            bytes: contents.as_bytes().to_vec(),
        }
    }

    fn manifest_json(name: &str, version: &str, api: &str) -> CatalogFile {
        file(
            "plugin.json",
            &format!(
                r#"{{"id":"com.example.{name}","name":"{name}","version":"{version}","apiVersion":"{api}"}}"#
            ),
        )
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn installs_a_version_with_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let files = vec![
            manifest_json("docker", "1.2.0", "1.0"),
            file("parse.js", "// code"),
        ];
        let m = install_version(root, "docker", v("1.2.0"), &files).unwrap();
        assert_eq!(m.version, "1.2.0");
        assert!(root.join("docker").join("plugin.json").is_file());
        assert!(root.join("docker").join("parse.js").is_file());
        // No staging/backup left behind.
        assert!(!root.join(".docker.tmp").exists());
        assert!(!root.join(".docker.bak").exists());
    }

    #[test]
    fn install_replaces_existing_version() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        install_version(root, "docker", v("1.0.0"), &[manifest_json("docker", "1.0.0", "1.0")])
            .unwrap();
        // Old version had an extra file that must be gone after replacement.
        std::fs::write(root.join("docker").join("old.txt"), "x").unwrap();

        install_version(root, "docker", v("1.2.0"), &[manifest_json("docker", "1.2.0", "1.0")])
            .unwrap();

        let raw = std::fs::read_to_string(root.join("docker").join("plugin.json")).unwrap();
        assert!(raw.contains("1.2.0"));
        // Replacement is clean: the stale file from the old version is gone.
        assert!(!root.join("docker").join("old.txt").exists());
    }

    #[test]
    fn rejects_version_folder_manifest_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        // Folder says 2.0.0 but manifest says 1.0.0.
        let err = install_version(
            tmp.path(),
            "docker",
            v("2.0.0"),
            &[manifest_json("docker", "1.0.0", "1.0")],
        )
        .unwrap_err();
        assert!(err.contains("does not match"));
        // Nothing installed.
        assert!(!tmp.path().join("docker").exists());
    }

    #[test]
    fn rejects_incompatible_api_major() {
        let tmp = tempfile::tempdir().unwrap();
        let err = install_version(
            tmp.path(),
            "docker",
            v("1.0.0"),
            &[manifest_json("docker", "1.0.0", "2.0")],
        )
        .unwrap_err();
        assert!(err.contains("incompatible"));
    }

    #[test]
    fn rejects_missing_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let err = install_version(tmp.path(), "docker", v("1.0.0"), &[file("readme.md", "x")])
            .unwrap_err();
        assert!(err.contains("missing plugin.json"));
    }

    #[test]
    fn rejects_unsafe_name() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(install_version(
            tmp.path(),
            "../escape",
            v("1.0.0"),
            &[manifest_json("escape", "1.0.0", "1.0")]
        )
        .is_err());
    }

    #[test]
    fn rejects_unsafe_file_path() {
        let tmp = tempfile::tempdir().unwrap();
        let files = vec![
            manifest_json("docker", "1.0.0", "1.0"),
            file("../evil.txt", "x"),
        ];
        let err = install_version(tmp.path(), "docker", v("1.0.0"), &files).unwrap_err();
        assert!(err.contains("unsafe file path"));
        // The traversal attempt left nothing outside the plugin dir.
        assert!(!tmp.path().join("evil.txt").exists());
    }
}
