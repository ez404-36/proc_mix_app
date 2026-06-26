//! Plugin system commands: installed-plugin lifecycle + catalog/install.
//!
//! Installed side (Phase 1): list / enable / disable / remove.
//! Catalog side (Phase 2): list the catalog of installable plugins and install a
//! specific version (which also serves update and rollback — all "write version
//! X, replacing what's there").
//!
//! Nothing here EXECUTES plugin code; install copies DATA only. The plugin
//! DEFINITION lives on disk; only the enabled/disabled flag is persisted (in
//! `storage::plugin_state`).

use std::sync::Arc;

use tauri::State;

use crate::plugins::{
    self, Contributes, PluginPermissions, PluginRoots, PluginSource, PluginView, Version,
};
use crate::plugins::catalog::CatalogSource;
use crate::storage::{plugin_state, DbPool};

/// Resolved plugin roots, managed in app state and shared by every plugin
/// command. Built once at startup (see `lib.rs` setup).
pub struct PluginState {
    pub roots: PluginRoots,
}

// ---------------------------------------------------------------------------
// Installed-plugin lifecycle
// ---------------------------------------------------------------------------

/// List every discovered (installed) plugin, deduplicated and status-annotated,
/// with the user's enabled/disabled flag applied. A broken plugin appears as an
/// `error` row rather than vanishing.
#[tauri::command]
pub async fn list_plugins(
    state: State<'_, Arc<PluginState>>,
    pool: State<'_, DbPool>,
) -> Result<Vec<PluginView>, String> {
    let disabled = plugin_state::load_disabled(pool.inner()).await?;
    Ok(plugins::load_plugins(&state.roots, &disabled))
}

/// Enable or disable an installed plugin by id. Persists the flag; the next
/// `list_plugins` reflects the new status.
#[tauri::command]
pub async fn set_plugin_enabled(
    pool: State<'_, DbPool>,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    plugin_state::set_enabled(pool.inner(), &plugin_id, enabled).await
}

/// Remove an installed plugin: delete its directory and forget its persisted
/// state. The command re-discovers to find the plugin's directory by id (never
/// trusting a client-supplied path), then deletes it.
#[tauri::command]
pub async fn remove_plugin(
    state: State<'_, Arc<PluginState>>,
    pool: State<'_, DbPool>,
    plugin_id: String,
) -> Result<(), String> {
    // Re-discover so we resolve the directory from the trusted backend scan,
    // never from a client-supplied path (path-traversal guard).
    let disabled = plugin_state::load_disabled(pool.inner()).await?;
    let views = plugins::load_plugins(&state.roots, &disabled);
    let target = views
        .iter()
        .find(|v| v.id == plugin_id)
        .ok_or_else(|| format!("plugin not found: {plugin_id}"))?;

    if target.source != PluginSource::User {
        return Err("only user-installed plugins are removable".into());
    }

    // Defence-in-depth: the resolved dir must live under the installed root.
    let dir = std::path::Path::new(&target.dir);
    if !dir.starts_with(&state.roots.installed) {
        return Err("refusing to remove a plugin outside the installed plugins directory".into());
    }

    std::fs::remove_dir_all(dir)
        .map_err(|e| format!("remove plugin directory {}: {e}", dir.display()))?;
    plugin_state::forget(pool.inner(), &plugin_id).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Catalog + install
// ---------------------------------------------------------------------------

/// One installable version, as presented to the UI. Carries the per-version
/// metadata needed to render the catalog card and the install consent.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersionView {
    /// Bare version string (e.g. `1.2.0`), matches the manifest `version`.
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog: Option<Vec<String>>,
    pub permissions: PluginPermissions,
    pub contributes: Contributes,
    /// Whether this version's API major is compatible with this build.
    pub compatible: bool,
    /// Declared target OSes (empty = universal). For display.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub os: Vec<String>,
    /// Whether this version supports the OS the app is running on. Advisory —
    /// the UI shows a hint but does NOT block install on `false` (the plugin's
    /// commands may target a remote host of a different OS over SSH).
    pub os_compatible: bool,
}

/// One plugin in the catalog: identity + its installable versions (newest
/// first) + which version is "latest".
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPluginView {
    /// Catalog folder name — the handle passed to `install_plugin_version`.
    pub name: String,
    /// Manifest id of the latest version (matches an installed plugin's id).
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Versions newest-first (UI shows latest by default, older for rollback).
    pub versions: Vec<CatalogVersionView>,
    /// The latest (highest-semver) version string.
    pub latest_version: String,
}

/// List the catalog of installable plugins (name, identity, versions). Reads the
/// local catalog source; no network in Phase 2.
#[tauri::command]
pub async fn list_plugin_catalog(
    state: State<'_, Arc<PluginState>>,
) -> Result<Vec<CatalogPluginView>, String> {
    let source = state.roots.catalog_source()?;
    let plugins = source.list()?;

    let mut out = Vec::with_capacity(plugins.len());
    for plugin in plugins {
        // `list` guarantees at least one version and ascending order.
        let latest = plugin
            .latest()
            .ok_or_else(|| format!("catalog plugin {} has no versions", plugin.name))?;
        let latest_version = latest.version.to_bare();
        let id = latest.manifest.id.clone();
        let display_name = latest.manifest.name.clone();
        let author = latest.manifest.author.clone();

        // Newest-first for display.
        let mut versions: Vec<CatalogVersionView> = plugin
            .versions
            .iter()
            .rev()
            .map(|v| CatalogVersionView {
                version: v.version.to_bare(),
                description: v.manifest.description.clone(),
                changelog: v.manifest.changelog.clone(),
                permissions: v.manifest.permissions.clone(),
                contributes: v.manifest.contributes.clone(),
                compatible: v.manifest.is_api_compatible(),
                os: v.manifest.os.clone(),
                os_compatible: v.manifest.supports_current_os(),
            })
            .collect();
        versions.shrink_to_fit();

        out.push(CatalogPluginView {
            name: plugin.name,
            id,
            display_name,
            author,
            versions,
            latest_version,
        });
    }
    Ok(out)
}

/// Install a specific version of a catalog plugin into the installed directory.
/// This single command serves install, update, and rollback — the caller passes
/// the desired version string. Installing over an existing plugin replaces it.
#[tauri::command]
pub async fn install_plugin_version(
    state: State<'_, Arc<PluginState>>,
    name: String,
    version: String,
) -> Result<PluginView, String> {
    let parsed = Version::parse(&version)
        .ok_or_else(|| format!("invalid version string: {version}"))?;

    let source = state.roots.catalog_source()?;
    let files = source.fetch_version(&name, parsed)?;
    let manifest =
        plugins::install::install_version(&state.roots.installed, &name, parsed, &files)?;

    // Return the freshly-installed plugin as a view by re-discovering. The
    // newly installed plugin defaults to enabled (no disabled row yet).
    let views = plugins::load_plugins(&state.roots, &std::collections::HashSet::new());
    views
        .into_iter()
        .find(|v| v.id == manifest.id)
        .ok_or_else(|| format!("installed plugin {} not found after install", manifest.id))
}
