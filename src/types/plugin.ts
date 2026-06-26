// Types for the plugin system (Phase 1).
//
// These mirror the Rust DTOs crossing the IPC boundary (camelCase):
//   - `PluginView`        ↔ `plugins::registry::PluginView`
//   - `PluginPermissions` ↔ `plugins::manifest::PluginPermissions`
//   - `Contributes`       ↔ `plugins::manifest::Contributes`
//   - `PluginSource`      ↔ `plugins::discovery::PluginSource`
//   - `PluginStatus`      ↔ `plugins::registry::PluginStatus`
//
// Phase 1 only DESCRIBES and MANAGES plugins (list / enable / disable / remove);
// nothing executes plugin code yet. See `docs/ideas/plugin-system.md` and
// `docs/plans/plugins/01_ui_section_and_plugin_entities_phase_1.md`.

/** Which root a plugin was discovered under (drives the trust/removability model). */
export type PluginSource = "core" | "community" | "user";

/**
 * Lifecycle status of a single plugin:
 *   - `enabled`        — parsed, API-compatible, and turned on (active);
 *   - `disabled`       — parsed and compatible, but the user turned it off;
 *   - `incompatible`   — parsed but targets an incompatible plugin-API major;
 *   - `osIncompatible` — enabled & API-OK, but the local OS is not in the
 *                        plugin's target list. ADVISORY only — still active,
 *                        since it may target a remote host of a different OS;
 *   - `error`          — manifest missing/unreadable/invalid (failed to load).
 */
export type PluginStatus =
  | "enabled"
  | "disabled"
  | "incompatible"
  | "osIncompatible"
  | "error";

/** Permissions a plugin requests. All default to `false` (deny). */
export interface PluginPermissions {
  network: boolean;
  fs: boolean;
  process: boolean;
}

/** Bundled content counts (ready-made commands / workflows). */
export interface ContributesContent {
  commands: number;
  workflows: number;
}

/**
 * What a plugin contributes, as counts. Phase 1 surfaces only these summary
 * numbers; later phases wire up each extension point concretely.
 */
export interface Contributes {
  parsers: number;
  presets: number;
  eventHandlers: number;
  nodeKinds: number;
  content: ContributesContent;
}

/**
 * A plugin as presented to the Plugins UI section. `id` is the manifest id, or —
 * for an unparseable manifest — the directory name, so an `error` row still has
 * a stable handle to address. Optional fields are absent when the manifest
 * failed to parse.
 */
export interface PluginView {
  id: string;
  name: string;
  version?: string;
  apiVersion?: string;
  author?: string;
  description?: string;
  /** Per-version list of changes ("what's new"), when the manifest provides it. */
  changelog?: string[];
  source: PluginSource;
  status: PluginStatus;
  permissions: PluginPermissions;
  contributes: Contributes;
  /** Declared target OSes (`linux`/`macos`/`windows`); empty = universal. */
  os?: string[];
  /** Whether the plugin supports the current OS (advisory; never blocks use). */
  osCompatible: boolean;
  /** Absolute path to the plugin directory (display; remove handle). */
  dir: string;
  /** Why the plugin failed to load, when `status === "error"`. */
  error?: string;
}

// --- Catalog (installable plugins) — mirrors `commands::plugins` DTOs --------

/**
 * One installable version of a catalog plugin. Carries per-version metadata for
 * the catalog card and the pre-install permission consent.
 * Mirrors `commands::plugins::CatalogVersionView`.
 */
export interface CatalogVersion {
  /** Bare version (e.g. `1.2.0`), matches an installed plugin's `version`. */
  version: string;
  description?: string;
  changelog?: string[];
  permissions: PluginPermissions;
  contributes: Contributes;
  /** Whether this version's API major is compatible with this build. */
  compatible: boolean;
  /** Declared target OSes; empty = universal. */
  os?: string[];
  /** Whether this version supports the current OS (advisory; never blocks install). */
  osCompatible: boolean;
}

/**
 * One plugin in the catalog: identity + installable versions (newest first).
 * Mirrors `commands::plugins::CatalogPluginView`.
 */
export interface CatalogPlugin {
  /** Catalog folder name — the handle passed to install. */
  name: string;
  /** Manifest id of the latest version (matches an installed plugin's id). */
  id: string;
  displayName: string;
  author?: string;
  /** Versions newest-first. */
  versions: CatalogVersion[];
  /** Latest (highest-semver) version string. */
  latestVersion: string;
}
