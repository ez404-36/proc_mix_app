import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePluginStore } from "../../stores/pluginStore";
import type {
  CatalogPlugin,
  Contributes,
  PluginView,
} from "../../types/plugin";
import { ToggleSwitch } from "../ToggleSwitch";
import { ConfirmDialog } from "../ConfirmDialog";
import { Dropdown } from "../Dropdown/Dropdown";

/** Parse `MAJOR.MINOR.PATCH` into a tuple; non-numeric parts become 0. */
function parseVersion(v: string): [number, number, number] {
  const [a = "0", b = "0", c = "0"] = v.split(".");
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0];
}

/** Compare two bare versions: -1 / 0 / 1 (numeric, not lexicographic). */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Plugin "type" = which extension point it contributes to. A plugin can have
 * several types (e.g. presets + content). Derived from `contributes` counts.
 */
type PluginType =
  | "parsers"
  | "presets"
  | "eventHandlers"
  | "nodeKinds"
  | "content";

/** All selectable types, in display order. */
const PLUGIN_TYPES: PluginType[] = [
  "parsers",
  "presets",
  "eventHandlers",
  "nodeKinds",
  "content",
];

/** The set of types a `contributes` block provides (non-zero counts). */
function typesOf(c: Contributes): Set<PluginType> {
  const set = new Set<PluginType>();
  if (c.parsers > 0) set.add("parsers");
  if (c.presets > 0) set.add("presets");
  if (c.eventHandlers > 0) set.add("eventHandlers");
  if (c.nodeKinds > 0) set.add("nodeKinds");
  if (c.content.commands > 0 || c.content.workflows > 0) set.add("content");
  return set;
}

/** Whether `c` provides at least one of the `selected` types (empty = any). */
function matchesTypes(c: Contributes, selected: PluginType[]): boolean {
  if (selected.length === 0) return true;
  const have = typesOf(c);
  return selected.some((t) => have.has(t));
}

/**
 * The "Plugins" top-level section.
 *
 * Two parts: **Installed** (manage what's on disk — enable/disable/remove,
 * update/rollback) and **Available** (the catalog — install a chosen version).
 * Nothing here executes plugin code; install copies data only.
 */
export function Plugins(): ReactElement {
  const { t } = useTranslation();
  const plugins = usePluginStore((s) => s.plugins);
  const catalog = usePluginStore((s) => s.catalog);
  const isLoading = usePluginStore((s) => s.isLoading);
  const installing = usePluginStore((s) => s.installing);
  const error = usePluginStore((s) => s.error);
  const load = usePluginStore((s) => s.load);
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const remove = usePluginStore((s) => s.remove);
  const install = usePluginStore((s) => s.install);

  // Plugin pending removal (drives the confirm dialog), or null when idle.
  const [pendingRemoval, setPendingRemoval] = useState<PluginView | null>(null);
  // Active tab: installed plugins vs the catalog of available plugins.
  const [tab, setTab] = useState<"installed" | "available">("installed");
  // Free-text filter, applied to the active tab (name + description).
  const [query, setQuery] = useState<string>("");
  // "Compatible only" filter (on by default): hides API-incompatible / errored
  // plugins. OS-incompatible plugins are kept (still usable via remote/SSH).
  const [compatibleOnly, setCompatibleOnly] = useState<boolean>(true);
  // "For this OS" filter (OFF by default): hides plugins that don't target the
  // current OS. Off by default because such plugins are often still wanted
  // (e.g. to run commands on a remote host of another OS over SSH).
  const [osOnly, setOsOnly] = useState<boolean>(false);
  // "Hide installed" filter for the catalog (ON by default): keeps the Available
  // tab focused on what's NOT installed yet. Managing an installed plugin
  // (reinstall/update/rollback) happens from the Installed tab.
  const [hideInstalled, setHideInstalled] = useState<boolean>(true);
  // Plugin-type multi-select filter (empty = any type). A plugin matches when it
  // provides at least one of the selected types.
  const [selectedTypes, setSelectedTypes] = useState<PluginType[]>([]);

  const toggleType = (type: PluginType): void => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Installed version keyed by manifest id — lets the catalog mark a plugin as
  // installed and detect whether an update/rollback target differs.
  const installedById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plugins) {
      if (p.version !== undefined) map.set(p.id, p.version);
    }
    return map;
  }, [plugins]);

  // Catalog entry keyed by manifest id — lets an installed plugin resolve its
  // catalog `name` (the install handle) to reinstall the same version.
  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogPlugin>();
    for (const entry of catalog) map.set(entry.id, entry);
    return map;
  }, [catalog]);

  const normalizedQuery = query.trim().toLowerCase();

  // Installed plugins filtered by name/description and, when "compatible only"
  // is on, by usability. NOTE: `osIncompatible` is NOT hidden by the API filter
  // — such a plugin is still usable (it may target a remote host of another OS);
  // only truly unusable rows (incompatible API / load error) are dropped. The
  // separate "for this OS" filter hides OS-mismatched plugins.
  const filteredPlugins = useMemo(() => {
    const matches = (fields: string[]): boolean =>
      normalizedQuery === "" ||
      fields.some((f) => f.toLowerCase().includes(normalizedQuery));
    return plugins.filter((p) => {
      if (compatibleOnly && (p.status === "incompatible" || p.status === "error")) {
        return false;
      }
      if (osOnly && !p.osCompatible) {
        return false;
      }
      if (!matchesTypes(p.contributes, selectedTypes)) {
        return false;
      }
      return matches([p.name, p.description ?? ""]);
    });
  }, [plugins, normalizedQuery, compatibleOnly, osOnly, selectedTypes]);

  // Catalog plugins filtered by display name + any version's description, by
  // API compatibility (when "compatible only" is on — at least one compatible
  // version), and by OS (when "for this OS" is on — at least one version that
  // targets the current OS).
  const filteredCatalog = useMemo(() => {
    const matches = (fields: string[]): boolean =>
      normalizedQuery === "" ||
      fields.some((f) => f.toLowerCase().includes(normalizedQuery));
    return catalog.filter((entry) => {
      if (hideInstalled && installedById.has(entry.id)) {
        return false;
      }
      if (compatibleOnly && !entry.versions.some((v) => v.compatible)) {
        return false;
      }
      if (osOnly && !entry.versions.some((v) => v.osCompatible)) {
        return false;
      }
      if (
        !entry.versions.some((v) => matchesTypes(v.contributes, selectedTypes))
      ) {
        return false;
      }
      return matches([
        entry.displayName,
        ...entry.versions.map((v) => v.description ?? ""),
      ]);
    });
  }, [
    catalog,
    normalizedQuery,
    compatibleOnly,
    osOnly,
    hideInstalled,
    installedById,
    selectedTypes,
  ]);

  const tabs = [
    { key: "installed" as const, count: plugins.length },
    { key: "available" as const, count: catalog.length },
  ];

  // Whether the active tab has any items at all (before filtering) — drives
  // the "no plugins / empty catalog" vs "no search matches" empty states.
  const activeHasItems =
    tab === "installed" ? plugins.length > 0 : catalog.length > 0;
  const activeFilteredEmpty =
    tab === "installed"
      ? filteredPlugins.length === 0
      : filteredCatalog.length === 0;

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("plugins.title")}</h1>
          <p className="view-subtitle">{t("plugins.subtitle")}</p>
        </div>
      </header>

      {error !== null ? (
        <section className="view-section">
          <div className="empty-state settings-info">
            <div className="settings-info__line">{t("plugins.loadError")}</div>
            <div className="settings-caption">{error}</div>
          </div>
        </section>
      ) : null}

      <div className="library-tabs-row">
        <div className="library-tabs" role="tablist">
          {tabs.map(({ key, count }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`library-tab${tab === key ? " is-active" : ""}`}
              onClick={() => setTab(key)}
            >
              {t(`plugins.${key}.title`)} ({count})
            </button>
          ))}
        </div>
      </div>

      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={t("plugins.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("plugins.searchPlaceholder")}
        />
        <label className="plugin-filter-toggle">
          <ToggleSwitch
            checked={compatibleOnly}
            onChange={setCompatibleOnly}
            ariaLabel={t("plugins.compatibleOnly")}
          />
          <span>{t("plugins.compatibleOnly")}</span>
        </label>
        <label className="plugin-filter-toggle">
          <ToggleSwitch
            checked={osOnly}
            onChange={setOsOnly}
            ariaLabel={t("plugins.osOnly")}
          />
          <span>{t("plugins.osOnly")}</span>
        </label>
        {tab === "available" ? (
          <label className="plugin-filter-toggle">
            <ToggleSwitch
              checked={hideInstalled}
              onChange={setHideInstalled}
              ariaLabel={t("plugins.hideInstalled")}
            />
            <span>{t("plugins.hideInstalled")}</span>
          </label>
        ) : null}
      </div>

      {/* Plugin-type multi-select filter (empty selection = any type). */}
      <div
        className="plugin-type-filter"
        role="group"
        aria-label={t("plugins.types.filterLabel")}
      >
        {PLUGIN_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={`tag-chip tag-chip--filter${
              selectedTypes.includes(type) ? " is-active" : ""
            }`}
            aria-pressed={selectedTypes.includes(type)}
            onClick={() => toggleType(type)}
          >
            {t(`plugins.types.${type}`)}
          </button>
        ))}
        {/* Always rendered (just hidden when idle) so toggling a type doesn't
            change the row's size — the filter bar stays static. */}
        <button
          type="button"
          className="btn btn--ghost plugin-type-filter__clear"
          onClick={() => setSelectedTypes([])}
          disabled={selectedTypes.length === 0}
          aria-hidden={selectedTypes.length === 0}
          style={
            selectedTypes.length === 0
              ? { visibility: "hidden" }
              : undefined
          }
        >
          {t("plugins.types.clear")}
        </button>
      </div>

      {/* Empty states: distinguish "nothing here" from "no search matches". */}
      {!isLoading && !activeHasItems ? (
        <section className="view-section">
          <div className="empty-state settings-info">
            {tab === "installed" ? (
              <>
                <div className="settings-info__line">
                  {t("plugins.empty.primary")}
                </div>
                <div className="settings-caption">
                  {t("plugins.empty.secondary")}
                </div>
              </>
            ) : (
              <div className="settings-info__line">
                {t("plugins.available.empty")}
              </div>
            )}
          </div>
        </section>
      ) : !isLoading && activeFilteredEmpty ? (
        <section className="view-section">
          <div className="empty-state settings-info">
            <div className="settings-info__line">
              {query.trim() === ""
                ? t("plugins.noCompatibleMatches")
                : t("plugins.noMatches", { query: query.trim() })}
            </div>
          </div>
        </section>
      ) : tab === "installed" ? (
        <section className="view-section">
          <ul className="plugin-list">
            {filteredPlugins.map((plugin) => {
              // Version management is possible only when the plugin still exists
              // in the catalog (so we can re-fetch its versions' files).
              const catalogEntry = catalogById.get(plugin.id);
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  onToggle={(enabled) => void setEnabled(plugin.id, enabled)}
                  onRequestRemove={() => setPendingRemoval(plugin)}
                  catalogEntry={catalogEntry}
                  installing={
                    catalogEntry !== undefined &&
                    installing === catalogEntry.name
                  }
                  onInstall={
                    catalogEntry !== undefined
                      ? (version) => void install(catalogEntry.name, version)
                      : undefined
                  }
                />
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="view-section">
          <ul className="plugin-list">
            {filteredCatalog.map((entry) => (
              <CatalogCard
                key={entry.name}
                entry={entry}
                installedVersion={installedById.get(entry.id) ?? null}
                installing={installing === entry.name}
                onInstall={(version) => void install(entry.name, version)}
              />
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={t("plugins.remove.title")}
        message={t("plugins.remove.message", {
          name: pendingRemoval?.name ?? "",
        })}
        confirmLabel={t("plugins.remove.confirm")}
        danger
        onConfirm={() => {
          if (pendingRemoval !== null) {
            void remove(pendingRemoval.id);
          }
          setPendingRemoval(null);
        }}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}

interface VersionInstallerProps {
  entry: CatalogPlugin;
  /** Installed version of this plugin, or null when not installed. */
  installedVersion: string | null;
  /** Currently selected version (controlled by the parent card). */
  selected: string;
  onSelect: (version: string) => void;
  installing: boolean;
  onInstall: (version: string) => void;
}

/**
 * Version management control shared by both tabs: a version selector and an
 * action whose label reflects the selected version's relation to the installed
 * one (install / update / rollback / reinstall). Controlled — the parent card
 * owns the selection so it can render version-dependent details (badges,
 * changelog, permissions). Used in the catalog card (Available) and the
 * installed card (Installed).
 */
function VersionInstaller({
  entry,
  installedVersion,
  selected,
  onSelect,
  installing,
  onInstall,
}: VersionInstallerProps): ReactElement {
  const { t } = useTranslation();

  const selectedVersion =
    entry.versions.find((v) => v.version === selected) ?? entry.versions[0];

  // Selected-vs-installed relation drives the action label.
  const relation: "install" | "reinstall" | "update" | "rollback" = (() => {
    if (installedVersion === null) return "install";
    const cmp = compareVersions(selectedVersion.version, installedVersion);
    if (cmp > 0) return "update";
    if (cmp < 0) return "rollback";
    return "reinstall";
  })();

  const actionLabel = t(`plugins.available.action.${relation}`);

  const versionOptions = entry.versions.map((v) => ({
    value: v.version,
    label:
      v.version === entry.latestVersion
        ? t("plugins.available.versionLatest", { version: v.version })
        : v.version,
  }));

  return (
    <span className="plugin-version-installer">
      <Dropdown
        value={selected}
        options={versionOptions}
        onChange={onSelect}
        ariaLabel={t("plugins.available.selectVersion", {
          name: entry.displayName,
        })}
      />
      <button
        type="button"
        className="btn btn--primary"
        disabled={installing || !selectedVersion.compatible}
        onClick={() => onInstall(selectedVersion.version)}
      >
        {installing ? t("plugins.available.installing") : actionLabel}
      </button>
    </span>
  );
}

interface CatalogCardProps {
  entry: CatalogPlugin;
  /** Installed version of this plugin, or null when not installed. */
  installedVersion: string | null;
  installing: boolean;
  onInstall: (version: string) => void;
}

/**
 * A catalog plugin card: identity, a version selector (default = latest),
 * the selected version's permissions/changelog, and an install/update/rollback
 * action whose label reflects the relation to the installed version.
 */
function CatalogCard({
  entry,
  installedVersion,
  installing,
  onInstall,
}: CatalogCardProps): ReactElement {
  const { t } = useTranslation();
  // Default the selector to the latest version.
  const [selected, setSelected] = useState<string>(entry.latestVersion);

  const selectedVersion =
    entry.versions.find((v) => v.version === selected) ?? entry.versions[0];

  const updateAvailable =
    installedVersion !== null &&
    compareVersions(entry.latestVersion, installedVersion) > 0;

  return (
    <li className="plugin-card">
      <div className="plugin-card__head">
        <div className="plugin-card__identity">
          <span className="plugin-card__name">{entry.displayName}</span>
          {installedVersion !== null ? (
            <span className="plugin-badge plugin-badge--enabled">
              {t("plugins.available.installedVersion", {
                version: installedVersion,
              })}
            </span>
          ) : null}
          {updateAvailable ? (
            <span className="plugin-badge plugin-badge--source">
              {t("plugins.available.updateAvailable")}
            </span>
          ) : null}
          {!selectedVersion.compatible ? (
            <span className="plugin-badge plugin-badge--incompatible">
              {t("plugins.status.incompatible")}
            </span>
          ) : null}
          {/* OS mismatch is advisory — flagged but never blocks install. */}
          {!selectedVersion.osCompatible ? (
            <span
              className="plugin-badge plugin-badge--os"
              title={t("plugins.os.hint")}
            >
              {t("plugins.status.osIncompatible")}
            </span>
          ) : null}
          <PluginTypeBadges contributes={selectedVersion.contributes} />
          <OsChips os={selectedVersion.os} />
        </div>

        <div className="plugin-card__actions">
          <VersionInstaller
            entry={entry}
            installedVersion={installedVersion}
            selected={selected}
            onSelect={setSelected}
            installing={installing}
            onInstall={onInstall}
          />
        </div>
      </div>

      {selectedVersion.description !== undefined ? (
        <p className="plugin-card__description">{selectedVersion.description}</p>
      ) : null}

      {selectedVersion.changelog !== undefined &&
      selectedVersion.changelog.length > 0 ? (
        <div className="plugin-card__meta">
          <span className="plugin-card__meta-label">
            {t("plugins.available.changelog")}
          </span>
          <ul className="plugin-changelog">
            {selectedVersion.changelog.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <CatalogPermissions
        permissions={selectedVersion.permissions}
      />
    </li>
  );
}

/** Requested-permission chips for a catalog version (consent before install). */
function CatalogPermissions({
  permissions,
}: {
  permissions: CatalogPlugin["versions"][number]["permissions"];
}): ReactElement | null {
  const { t } = useTranslation();
  const perms: string[] = [];
  if (permissions.network) perms.push(t("plugins.permissions.network"));
  if (permissions.fs) perms.push(t("plugins.permissions.fs"));
  if (permissions.process) perms.push(t("plugins.permissions.process"));
  if (perms.length === 0) return null;

  return (
    <div className="plugin-card__chips">
      <span className="plugin-card__meta-label">
        {t("plugins.permissions.label")}
      </span>
      {perms.map((p) => (
        <span key={p} className="plugin-chip plugin-chip--permission">
          {p}
        </span>
      ))}
    </div>
  );
}

/**
 * Type badges — which extension points a plugin contributes to (parsers,
 * presets, integrations, nodes, content). Shows nothing when the plugin
 * declares no contributions.
 */
function PluginTypeBadges({
  contributes,
}: {
  contributes: Contributes;
}): ReactElement | null {
  const { t } = useTranslation();
  const types = PLUGIN_TYPES.filter((type) => typesOf(contributes).has(type));
  if (types.length === 0) return null;

  return (
    <span className="plugin-types">
      {types.map((type) => (
        <span key={type} className="plugin-badge plugin-badge--type">
          {t(`plugins.types.${type}`)}
        </span>
      ))}
    </span>
  );
}

/**
 * Target-OS chips. Renders the declared OS list; an empty/undefined list means
 * the plugin is universal and shows a single "any OS" chip. Informational only.
 */
function OsChips({ os }: { os?: string[] }): ReactElement {
  const { t } = useTranslation();
  const known = new Set(["linux", "macos", "windows"]);
  const labelFor = (id: string): string =>
    known.has(id) ? t(`plugins.os.${id}`) : id;

  return (
    <span className="plugin-os">
      {os === undefined || os.length === 0 ? (
        <span className="plugin-chip plugin-chip--os">
          {t("plugins.os.universal")}
        </span>
      ) : (
        os.map((id) => (
          <span key={id} className="plugin-chip plugin-chip--os">
            {labelFor(id)}
          </span>
        ))
      )}
    </span>
  );
}

interface PluginCardProps {
  plugin: PluginView;
  onToggle: (enabled: boolean) => void;
  onRequestRemove: () => void;
  /** Catalog entry for this plugin (for version management); absent if not in the catalog. */
  catalogEntry?: CatalogPlugin;
  /** Whether this plugin is currently being (re)installed. */
  installing?: boolean;
  /** Install a specific version (reinstall / update / rollback). */
  onInstall?: (version: string) => void;
}

/** A single plugin row: identity, status badge, contributions, permissions, and actions. */
function PluginCard({
  plugin,
  onToggle,
  onRequestRemove,
  catalogEntry,
  installing = false,
  onInstall,
}: PluginCardProps): ReactElement {
  const { t } = useTranslation();
  // Version selector for the version management control; defaults to installed.
  const [selectedVersion, setSelectedVersion] = useState<string>(
    plugin.version ?? "",
  );

  // A parsed, API-compatible plugin can be toggled. `osIncompatible` is an
  // ADVISORY state (still effectively enabled — may target a remote OS), so it
  // counts as on/toggleable; only `error`/`incompatible` lack a switch.
  const toggleable =
    plugin.status === "enabled" ||
    plugin.status === "disabled" ||
    plugin.status === "osIncompatible";
  const isEnabled =
    plugin.status === "enabled" || plugin.status === "osIncompatible";
  const isRemovable = plugin.source === "user";

  // Version management is available only when the plugin is in the catalog.
  const canManageVersions =
    catalogEntry !== undefined &&
    onInstall !== undefined &&
    plugin.version !== undefined;
  const updateAvailable =
    canManageVersions &&
    compareVersions(catalogEntry.latestVersion, plugin.version as string) > 0;

  return (
    <li className="plugin-card">
      <div className="plugin-card__head">
        <div className="plugin-card__identity">
          <span className="plugin-card__name">{plugin.name}</span>
          {plugin.version !== undefined ? (
            <span className="plugin-card__version">v{plugin.version}</span>
          ) : null}
          <span className={`plugin-badge plugin-badge--${plugin.status}`}>
            {t(`plugins.status.${plugin.status}`)}
          </span>
          {updateAvailable ? (
            <span className="plugin-badge plugin-badge--source">
              {t("plugins.available.updateAvailable")}
            </span>
          ) : null}
          <PluginTypeBadges contributes={plugin.contributes} />
          <OsChips os={plugin.os} />
        </div>

        <div className="plugin-card__actions">
          {toggleable ? (
            <ToggleSwitch
              checked={isEnabled}
              onChange={onToggle}
              ariaLabel={t("plugins.toggleLabel", { name: plugin.name })}
            />
          ) : null}
          {canManageVersions ? (
            <VersionInstaller
              entry={catalogEntry}
              installedVersion={plugin.version as string}
              selected={selectedVersion}
              onSelect={setSelectedVersion}
              installing={installing}
              onInstall={onInstall}
            />
          ) : null}
          {isRemovable ? (
            <button
              type="button"
              className="btn btn--danger"
              onClick={onRequestRemove}
            >
              {t("plugins.remove.action")}
            </button>
          ) : null}
        </div>
      </div>

      {plugin.description !== undefined ? (
        <p className="plugin-card__description">{plugin.description}</p>
      ) : null}

      {plugin.status === "error" && plugin.error !== undefined ? (
        <p className="plugin-card__error">{plugin.error}</p>
      ) : null}

      {plugin.status !== "error" ? (
        <PluginContributes plugin={plugin} />
      ) : null}
    </li>
  );
}

/** Summary of what a plugin contributes plus its requested permissions. */
function PluginContributes({ plugin }: { plugin: PluginView }): ReactElement {
  const { t } = useTranslation();
  const c = plugin.contributes;

  // Build the non-zero contribution chips so an empty plugin shows nothing.
  const chips: string[] = [];
  if (c.parsers > 0) chips.push(t("plugins.contributes.parsers", { count: c.parsers }));
  if (c.presets > 0) chips.push(t("plugins.contributes.presets", { count: c.presets }));
  if (c.eventHandlers > 0)
    chips.push(t("plugins.contributes.eventHandlers", { count: c.eventHandlers }));
  if (c.nodeKinds > 0)
    chips.push(t("plugins.contributes.nodeKinds", { count: c.nodeKinds }));
  if (c.content.commands > 0)
    chips.push(t("plugins.contributes.commands", { count: c.content.commands }));
  if (c.content.workflows > 0)
    chips.push(t("plugins.contributes.workflows", { count: c.content.workflows }));

  const permissions: string[] = [];
  if (plugin.permissions.network) permissions.push(t("plugins.permissions.network"));
  if (plugin.permissions.fs) permissions.push(t("plugins.permissions.fs"));
  if (plugin.permissions.process) permissions.push(t("plugins.permissions.process"));

  return (
    <div className="plugin-card__meta">
      {chips.length > 0 ? (
        <div className="plugin-card__chips">
          <span className="plugin-card__meta-label">
            {t("plugins.contributes.label")}
          </span>
          {chips.map((chip) => (
            <span key={chip} className="plugin-chip">
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      {permissions.length > 0 ? (
        <div className="plugin-card__chips">
          <span className="plugin-card__meta-label">
            {t("plugins.permissions.label")}
          </span>
          {permissions.map((perm) => (
            <span key={perm} className="plugin-chip plugin-chip--permission">
              {perm}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
