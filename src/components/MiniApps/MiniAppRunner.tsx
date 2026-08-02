import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Message } from "@arco-design/web-react";
import { useTranslation } from "react-i18next";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useUIStore } from "../../stores/uiStore";
import type { MiniApp } from "../../types";
import {
  useMiniAppStatusPolling,
  type StatusWidgetConfig,
} from "../../services/miniappStatusPoller";
import { ArrowLeftIcon } from "../icons";
import { MiniAppWidget } from "./MiniAppWidget";
import { renderIcon } from "../../utils/iconRenderer";
import { resolveArtifactValues } from "../../utils/resolveArtifactValues";
import { collectArtifactSpecSources } from "../../utils/miniappInlineCommand";
import {
  getMiniAppDescription,
  getMiniAppName,
} from "../../utils/miniappLabels";

/**
 * Minimum sane default interval for a status widget that forgot to set one,
 * and the floor applied to the toggle's optional `intervalMs`. Matches the
 * poller's own `MIN_INTERVAL_MS` clamp (1s) so a missing value still polls.
 */
const DEFAULT_STATUS_INTERVAL_MS = 5000;

/**
 * The widget panel is a relative canvas whose height grows with the widgets
 * placed on it. `PANEL_MIN_HEIGHT` is the guaranteed floor (also mirrored in
 * the `.miniapp-runner__panel` CSS rule); `PANEL_BOTTOM_PADDING` keeps the
 * bottom-most widget from sitting flush against the panel edge.
 */
const PANEL_MIN_HEIGHT = 400;
const PANEL_BOTTOM_PADDING = 24;

/**
 * Trailing debounce delay for writing an edited `persist: true` artifact
 * value back to the mini-app's SQLite record. Long enough that normal typing
 * coalesces into a single write, short enough that a value survives a quick
 * app restart shortly after the user stops editing.
 */
const PERSIST_DEBOUNCE_MS = 600;

/**
 * Build the poller config list for a mini-app: every `status` widget, plus
 * every `toggle` widget that carries a `status` source. Buttons, artifacts,
 * and status-less toggles contribute nothing. The list is rebuilt each
 * render but the poller diffs by a serialized signature internally, so the
 * polling lifecycle only resets on a real change.
 *
 * `variableValues` carries the current artifact values so a status probe
 * whose inline script (or referenced command) references `${artifactName}`
 * resolves it server-side via the same `core/parser.rs` substitution the
 * executor uses. It is forwarded on every config but intentionally omitted
 * from the poller's config-signature diff (see `miniappStatusPoller`) so a
 * value edit does NOT tear down + rebuild the polling lifecycle — only the
 * next tick reads the fresh map.
 */
function buildStatusConfigs(
  miniapp: MiniApp,
  variableValues: Readonly<Record<string, string>>,
): StatusWidgetConfig[] {
  const configs: StatusWidgetConfig[] = [];
  for (const w of miniapp.widgets) {
    if (w.kind === "status") {
      configs.push({
        widgetId: w.id,
        source: w.source,
        intervalMs:
          w.intervalMs > 0 ? w.intervalMs : DEFAULT_STATUS_INTERVAL_MS,
        mapping: w.mapping,
        variableValues,
      });
    } else if (w.kind === "toggle" && w.status !== undefined) {
      configs.push({
        widgetId: w.id,
        source: w.status.source,
        intervalMs:
          (w.status.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS) > 0
            ? (w.status.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS)
            : DEFAULT_STATUS_INTERVAL_MS,
        mapping: w.status.mapping,
        variableValues,
      });
    }
  }
  return configs;
}

/**
 * Runtime view for a single Mini-App (`miniapp-runner`). Resolves the
 * mini-app by `miniappRunnerId` from the UI store, renders its widget panel,
 * drives the shared status poller for status/toggle-with-status widgets, and
 * bumps the mini-app's run count whenever a button/toggle action fires.
 *
 * Mirrors the `ScheduleEditor` / `CommandEditor` full-screen view contract:
 * the id to open comes from `useUIStore.miniappRunnerId` (set by the list's
 * Run action), and leaving is an explicit navigation back to the Mini-Apps
 * list. An invalid id (deleted mini-app, stale route) shows an error state
 * with a back action rather than bouncing automatically, so the user sees
 * what happened.
 */
export function MiniAppRunner(): ReactElement {
  const { t } = useTranslation();
  const miniappRunnerId = useUIStore((s) => s.miniappRunnerId);
  const setView = useUIStore((s) => s.setView);
  const setLibraryTab = useUIStore((s) => s.setLibraryTab);
  const setMiniappRunnerId = useUIStore((s) => s.setMiniappRunnerId);
  const miniapps = useMiniAppStore((s) => s.miniapps);
  const markMiniAppRun = useMiniAppStore((s) => s.markMiniAppRun);

  const miniapp = useMemo(
    () => miniapps.find((m) => m.id === miniappRunnerId) ?? null,
    [miniapps, miniappRunnerId],
  );

  // Collect the mini-app's artifact widgets + their declared names. The names
  // form the set `resolveArtifactValues` consults to tell an artifact
  // reference (`${configPath}`, resolved here for display + fed to Rust for
  // execution) apart from a command variable reference (`${region}`, resolved
  // by Rust only). Built from the resolved mini-app so a deep-link into the
  // runner that hydrates after mount still sees the full set.
  const artifactWidgets = useMemo(
    () => miniapp?.widgets.filter((w) => w.kind === "artifact") ?? [],
    [miniapp],
  );
  const artifactNames = useMemo(() => {
    const names = new Set<string>();
    for (const w of artifactWidgets) {
      if (w.kind === "artifact" && w.name !== "") names.add(w.name);
    }
    return names;
  }, [artifactWidgets]);

  // Names of artifacts eligible for debounced write-back to SQLite:
  // `persist === true` AND `variant !== "secret"`. The variant re-check is
  // independent, defense-in-depth — the editor (`validateMiniApp.ts`)
  // already forbids authoring `persist: true` on a secret artifact, but a
  // malformed import or a legacy record could still carry that combination,
  // and a secret value must NEVER be written back to SQLite in plaintext
  // through this path regardless of what `persist` says. When this set is
  // empty (no mini-app widget uses the feature) the debounce machinery below
  // never schedules anything, so there is no per-keystroke overhead.
  const persistEligibleNames = useMemo(() => {
    const names = new Set<string>();
    for (const w of artifactWidgets) {
      if (
        w.kind === "artifact" &&
        w.name !== "" &&
        w.persist === true &&
        w.variant !== "secret"
      ) {
        names.add(w.name);
      }
    }
    return names;
  }, [artifactWidgets]);

  // Artifact → `VariableSpec` sources, threaded into every widget so each
  // action synthesizes a spec per artifact (missing-value fallback + secret
  // redaction). See `utils/miniappInlineCommand`.
  const artifactSpecs = useMemo(
    () => collectArtifactSpecSources(artifactWidgets),
    [artifactWidgets],
  );

  // Duplicate artifact names collapse into a SINGLE entry in `artifactValues`
  // (it is keyed by name), so two inputs sharing a name mirror each other.
  // That is confusing but not corrupting; surface it once per mini-app rather
  // than letting the user discover it by typing. Preventing it at authoring
  // time is the editor's job.
  const duplicateArtifactNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const w of artifactWidgets) {
      if (w.kind !== "artifact" || w.name === "") continue;
      if (seen.has(w.name)) duplicates.add(w.name);
      seen.add(w.name);
    }
    return [...duplicates];
  }, [artifactWidgets]);

  const duplicateWarningKey = duplicateArtifactNames.join("|");
  useEffect(() => {
    if (duplicateWarningKey === "") return;
    Message.warning(
      t("miniapps.runner.duplicateArtifacts", {
        names: duplicateWarningKey.split("|").join(", "),
      }),
    );
  }, [duplicateWarningKey, t]);

  // Current artifact values, keyed by artifact `name`. Initialized from each
  // artifact's editor default (`widget.value`) on first resolve of the
  // mini-app, then mutated by the interactive artifact inputs. The init is
  // keyed on the widget identity set (derived from `miniapp`) via the
  // functional-initializer so it runs once per distinct mini-app rather than
  // every render — otherwise typing into one input would reset the others.
  const [artifactValues, setArtifactValues] = useState<Record<string, string>>(
    {},
  );
  const artifactWidgetsKey = artifactWidgets.map((w) => w.id).join("|");
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const w of artifactWidgets) {
      if (w.kind === "artifact" && w.name !== "") init[w.name] = w.value;
    }
    setArtifactValues(init);
    // `artifactWidgetsKey` is a stable signature of the widget set; the
    // per-widget array reference changes each render but the key does not, so
    // this only re-initializes when the user opens a different mini-app (or
    // the editor adds/removes an artifact). `artifactWidgets` is read inside
    // but intentionally omitted — the key is its derived identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactWidgetsKey]);

  // One independent debounce timer per artifact name, so editing artifact A
  // does not reset or delay a pending write for artifact B. Cleared on
  // unmount / mini-app change (see effect below) without flushing — the
  // write-back is "last settled value", not "every keystroke guaranteed".
  const persistTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    const timers = persistTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [miniapp?.id]);

  const writeBackArtifactValue = (name: string, value: string): void => {
    const currentMiniApp = useMiniAppStore
      .getState()
      .miniapps.find((m) => m.id === miniapp?.id);
    if (currentMiniApp === undefined) return;
    const widget = currentMiniApp.widgets.find(
      (w) => w.kind === "artifact" && w.name === name,
    );
    // Re-verify eligibility at write time (defense in depth): the artifact
    // must still exist, still be marked `persist: true`, and still NOT be a
    // `secret` variant. A secret artifact's value is never written back to
    // SQLite through this mechanism, no matter what `persist` says.
    if (
      widget === undefined ||
      widget.kind !== "artifact" ||
      widget.persist !== true ||
      widget.variant === "secret"
    ) {
      return;
    }
    const patchedWidgets = currentMiniApp.widgets.map((w) =>
      w.kind === "artifact" && w.name === name ? { ...w, value } : w,
    );
    useMiniAppStore
      .getState()
      .updateMiniApp(currentMiniApp.id, { widgets: patchedWidgets });
  };

  const updateArtifactValue = (name: string, value: string): void => {
    setArtifactValues((prev) => ({ ...prev, [name]: value }));
    if (!persistEligibleNames.has(name)) return;
    const timers = persistTimersRef.current;
    const existing = timers.get(name);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        writeBackArtifactValue(name, value);
      }, PERSIST_DEBOUNCE_MS),
    );
  };

  // `ReadonlyMap` view of the artifact values for the display-text resolver.
  // Rebuilt each render (cheap); the resolver is pure so identity does not
  // gate any memo downstream.
  const valuesMap = useMemo(
    () => new Map(Object.entries(artifactValues)),
    [artifactValues],
  );

  // Execution-side values: the raw artifact values, routed through
  // `RunOptions.variableValues` so Rust's `core/parser.rs` substitutes
  // `${artifactName}` in the script / args / workingDir / env. The map is
  // passed verbatim (no client-side pre-substitution) — single-pass Rust
  // substitution is the contract. An artifact value that itself references
  // another artifact is left as a literal template by Rust (no recursion);
  // that is the documented v1 limitation.
  const executionValues = artifactValues;

  // Build the poller configs from the resolved mini-app + current artifact
  // values. Rebuilt each render from `widgets`; the poller's signature diff
  // keeps the lifecycle stable (and `variableValues` is excluded from that
  // signature so typing into an artifact input does not reset polling).
  const statusConfigs = useMemo(
    () => (miniapp ? buildStatusConfigs(miniapp, executionValues) : []),
    [miniapp, executionValues],
  );
  const statusResults = useMiniAppStatusPolling(statusConfigs);

  // The panel's primary dimensions come from `miniapp.panelSize` (set in the
  // editor). This content-driven height is a floor so a widget placed beyond
  // the configured `panelSize.h` is never clipped: the rendered panel is the
  // larger of `panelSize.h` and the bottom-most widget + padding. When there is
  // nothing to lay out it falls back to `PANEL_MIN_HEIGHT` (legacy default).
  const panelMinHeight = useMemo(() => {
    const widgets = miniapp?.widgets ?? [];
    let maxBottom = 0;
    for (const w of widgets) {
      const bottom = w.layout.y + w.layout.h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return Math.max(PANEL_MIN_HEIGHT, maxBottom + PANEL_BOTTOM_PADDING);
  }, [miniapp]);

  // Hydrate the store from SQLite on mount (idempotent) so a deep-link into
  // the runner — before the list ever loaded — still resolves the mini-app.
  // The store swallows its own errors and flips `hydrated` either way.
  useEffect(() => {
    void useMiniAppStore.getState().hydrateFromDb();
  }, []);

  const handleBack = (): void => {
    setMiniappRunnerId(null);
    setLibraryTab("miniapps");
    setView("library");
  };

  const handleActionComplete = (): void => {
    if (miniapp !== null) {
      markMiniAppRun(miniapp.id);
    }
  };

  if (miniapp === null) {
    return (
      <div>
        <header className="view-header">
          <div className="miniapp-runner__title-wrap">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleBack}
              aria-label={t("miniapps.runner.back")}
              title={t("miniapps.runner.back")}
            >
              <ArrowLeftIcon />
            </button>
            <div>
              <h1 className="view-title">{t("miniapps.runner.notFoundTitle")}</h1>
              <p className="view-subtitle">{t("miniapps.runner.notFoundHint")}</p>
            </div>
          </div>
        </header>
      </div>
    );
  }

  // Seed mini-apps carry `nameKey` / `descriptionKey`; user-created ones use
  // their literal strings. Resolved through the same helper the list uses.
  const displayName = getMiniAppName(miniapp, t);
  const rawDescription = getMiniAppDescription(miniapp, t);
  const description =
    rawDescription !== undefined && rawDescription.trim() !== ""
      ? resolveArtifactValues(rawDescription, valuesMap, artifactNames)
      : undefined;

  return (
    <div>
      <header className="view-header">
        <div className="miniapp-runner__title-wrap">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleBack}
            aria-label={t("miniapps.runner.back")}
            title={t("miniapps.runner.back")}
          >
            <ArrowLeftIcon />
          </button>
          <div>
            <h1 className="view-title">
              {renderIcon(miniapp.icon, 20, "view-title__icon")}
              {displayName}
            </h1>
            {description !== undefined ? (
              <p className="view-subtitle">{description}</p>
            ) : null}
          </div>
        </div>
      </header>

      {miniapp.widgets.length === 0 ? (
        <div className="empty-state">{t("miniapps.runner.noWidgets")}</div>
      ) : (
        <div
          className="miniapp-runner__panel"
          style={{
            width: miniapp.panelSize.w,
            minHeight: Math.max(miniapp.panelSize.h, panelMinHeight),
          }}
        >
          {miniapp.widgets.map((widget) => (
            <div
              key={widget.id}
              className="miniapp-runner__widget-slot"
              style={{
                left: widget.layout.x,
                top: widget.layout.y,
                width: widget.layout.w,
                height: widget.layout.h,
              }}
            >
              <MiniAppWidget
                widget={widget}
                statusResult={statusResults[widget.id]}
                onActionComplete={handleActionComplete}
                artifactValues={artifactValues}
                onArtifactChange={updateArtifactValue}
                artifactNames={artifactNames}
                valuesMap={valuesMap}
                executionValues={executionValues}
                artifactSpecs={artifactSpecs}
                bordered={false}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
