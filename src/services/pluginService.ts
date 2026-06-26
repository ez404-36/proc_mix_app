// Typed wrappers around the plugin-system Tauri commands (Phase 1).
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly. Phase 1 only
// lists/toggles/removes plugins — nothing here executes plugin code. See
// `docs/plans/plugins/01_ui_section_and_plugin_entities_phase_1.md`.

import { invoke } from "@tauri-apps/api/core";
import type { CatalogPlugin, PluginView } from "../types/plugin";

/**
 * List every discovered plugin, deduplicated and status-annotated, with the
 * user's enabled/disabled flag applied. A broken plugin appears as an `error`
 * row rather than vanishing.
 */
export async function listPlugins(): Promise<PluginView[]> {
  return invoke<PluginView[]>("list_plugins");
}

/**
 * Enable or disable a plugin by id. The flag is persisted; a subsequent
 * {@link listPlugins} reflects the new status.
 */
export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  await invoke("set_plugin_enabled", { pluginId, enabled });
}

/**
 * Remove a user-installed plugin: deletes its directory and forgets its state.
 * Only `user`-source plugins are removable; the backend rejects an attempt to
 * remove a shipped (`core`/`community`) plugin.
 */
export async function removePlugin(pluginId: string): Promise<void> {
  await invoke("remove_plugin", { pluginId });
}

/**
 * List the catalog of installable plugins (each with its available versions).
 * Reads the local catalog source — no network in this phase.
 */
export async function listPluginCatalog(): Promise<CatalogPlugin[]> {
  return invoke<CatalogPlugin[]>("list_plugin_catalog");
}

/**
 * Install a specific version of a catalog plugin. The same call serves install,
 * update, and rollback — pass the desired version. Installing over an existing
 * plugin replaces it. Returns the freshly-installed plugin view.
 */
export async function installPluginVersion(
  name: string,
  version: string,
): Promise<PluginView> {
  return invoke<PluginView>("install_plugin_version", { name, version });
}
