// Console (F8) — poll-driven output panel for web-fired runs.
//
// Mirrors the desktop OutputPanel's structure and `output-panel__*` classes,
// adapted to the web's poll model: it shows the runs THIS browser session
// fired, their status, and captured output (filled on terminal per O2 option
// B). Functional buttons mirror the app where they apply over HTTP — position,
// Clear (terminated), Close, Re-run — but NOT Cancel (O1, not implemented).
//
// The console is hidden by default and never auto-opens on a run; it opens only
// via the shell's console toggle (F9). Output is poll-updated, not streamed.

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { CancelIcon } from "@app/components/icons/CancelIcon";
import { ClearIcon } from "@app/components/icons/ClearIcon";
import { RerunIcon } from "@app/components/icons/RerunIcon";
import { Dropdown } from "@app/components/Dropdown";
import type { DropdownOption } from "@app/components/Dropdown";
import { useRunStore } from "../stores/runStore";
import type { TrackedRun, TrackedStatus } from "../stores/runStore";
import { useRunActions } from "../hooks/useRunActions";
import { useEntitiesStore } from "../stores/entitiesStore";
import { usePortraitPhone } from "../hooks/usePortraitPhone";

/** Map our status to the desktop console's CSS dot/status modifier names. */
function cssStatus(status: TrackedStatus): string {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "error";
    case "running":
      return "running";
    case "pending":
    default:
      return "pending";
  }
}

function statusLabel(run: TrackedRun, t: TFunction): string {
  switch (run.status) {
    case "pending":
      return t("outputPanel.status.pending", "Pending");
    case "running":
      return t("outputPanel.status.running", "Running");
    case "succeeded":
      return t("outputPanel.status.success", "Success");
    case "failed":
      return t("outputPanel.status.error", "Error");
    case "cancelled":
      return t("outputPanel.status.cancelled", "Cancelled");
    case "stale":
      return t("web.console.stale", "Still running — check History");
  }
}

export function Console(): React.JSX.Element | null {
  const { t } = useTranslation();
  const {
    runs,
    activeId,
    panelOpen,
    position,
    panelHeight,
    panelWidth,
    setActive,
    setPanelOpen,
    setPosition,
    setPanelHeight,
    setPanelWidth,
    clearTerminated,
  } = useRunStore(
    useShallow((s) => ({
      runs: s.runs,
      activeId: s.activeId,
      panelOpen: s.panelOpen,
      position: s.position,
      panelHeight: s.panelHeight,
      panelWidth: s.panelWidth,
      setActive: s.setActive,
      setPanelOpen: s.setPanelOpen,
      setPosition: s.setPosition,
      setPanelHeight: s.setPanelHeight,
      setPanelWidth: s.setPanelWidth,
      clearTerminated: s.clearTerminated,
    })),
  );

  // In portrait the console docks to the TOP (not bottom): the resize handle is
  // on the panel's bottom edge, so a downward drag must GROW the panel — the
  // opposite of the desktop bottom dock. This flag flips the drag delta and
  // tags the panel for the top-dock CSS override.
  const isPortraitPhone = usePortraitPhone();
  const topDocked = isPortraitPhone && position === "bottom";

  const { run } = useRunActions();
  const entities = useEntitiesStore((s) => s.entities);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const active = activeId
    ? (runs.find((r) => r.executionId === activeId) ?? null)
    : null;
  const outputLen = active?.output?.length ?? 0;

  // Auto-scroll the body to the newest line as output grows / selection changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outputLen, activeId]);

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const bottom = position === "bottom";
    const start = bottom ? event.clientY : event.clientX;
    const startSize = bottom ? panelHeight : panelWidth;
    const onMove = (e: PointerEvent): void => {
      if (bottom) {
        // Bottom dock: handle on top edge, drag UP grows (start - y).
        // Top dock (portrait): handle on bottom edge, drag DOWN grows (y - start).
        const heightDelta = topDocked ? e.clientY - start : start - e.clientY;
        setPanelHeight(startSize + heightDelta);
      } else {
        const delta = position === "right" ? start - e.clientX : e.clientX - start;
        setPanelWidth(startSize + delta);
      }
    };
    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  // Re-run the active run's source entity (resolved from the loaded list), if
  // it is still API-visible. A run whose source is gone can't be replayed.
  const rerunSource = active
    ? entities.find(
        (e) =>
          e.kind === active.kind &&
          (e.name === active.name || e.id === active.name),
      )
    : undefined;

  if (!panelOpen) return null;

  const panelStyle =
    position === "bottom" ? { height: panelHeight } : { width: panelWidth };

  const positions: ReadonlyArray<DropdownOption> = [
    { value: "bottom", label: t("outputPanel.position.bottom", "Снизу") },
    { value: "right", label: t("outputPanel.position.right", "Справа") },
    { value: "left", label: t("outputPanel.position.left", "Слева") },
  ];

  return (
    <div
      className={`output-panel output-panel--${position}${
        topDocked ? " output-panel--portrait-top" : ""
      }`}
      role="region"
      aria-label={t("outputPanel.ariaLabel", "Console")}
      style={panelStyle}
    >
      <div
        className="output-panel__resize"
        role="separator"
        aria-orientation={position === "bottom" ? "horizontal" : "vertical"}
        aria-label={t("outputPanel.resizeLabel", "Resize console")}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
      />

      <div className="output-panel__header">
        <div className="output-panel__title-row">
          <span className="output-panel__title">
            {active
              ? (active.customName ?? active.name)
              : t("outputPanel.defaultTitle", "Console")}
          </span>
          {active ? (
            <span
              className={`output-panel__status output-panel__status--${cssStatus(active.status)}`}
            >
              {statusLabel(active, t)}
            </span>
          ) : null}
          {active?.exitCode !== undefined ? (
            <span className="output-panel__meta">
              {t("outputPanel.exitCode", "exit {{code}}").replace(
                "{{code}}",
                String(active.exitCode),
              )}
            </span>
          ) : null}
          {active &&
          active.status !== "running" &&
          active.status !== "pending" &&
          rerunSource ? (
            <button
              type="button"
              className="btn command-form__action command-form__action--run output-panel__inline-action"
              onClick={() => void run(rerunSource).catch(() => {})}
              title={t("outputPanel.rerunTitle", "Run again")}
            >
              <span className="command-form__action-icon--run">
                <RerunIcon />
              </span>
              {t("outputPanel.rerun", "Re-run")}
            </button>
          ) : null}
        </div>
        <div className="output-panel__actions">
          <Dropdown
            value={position}
            options={positions}
            onChange={(value) => setPosition(value as typeof position)}
            ariaLabel={t("outputPanel.positionTitle", "Console position")}
            className="output-panel__position-select"
          />
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={clearTerminated}
            title={t("outputPanel.clearTitle", "Clear finished runs")}
          >
            <span className="command-form__action-icon--cancel">
              <ClearIcon />
            </span>
            {t("common.clear", "Clear")}
          </button>
          <button
            type="button"
            className="btn btn--view command-form__action"
            onClick={() => setPanelOpen(false)}
            title={t("outputPanel.closeTitle", "Close console")}
          >
            <span className="btn--view-icon">
              <CancelIcon />
            </span>
            {t("common.close", "Close")}
          </button>
        </div>
      </div>

      <ConsoleBody active={active} bodyRef={bodyRef} />

      {runs.length >= 1 ? (
        <div className="output-panel__recents">
          {runs.map((r) => (
            <button
              key={r.executionId}
              type="button"
              className={`output-panel__recent${
                r.executionId === activeId ? " is-active" : ""
              }`}
              onClick={() => setActive(r.executionId)}
              title={r.customName ?? r.name}
            >
              <span
                className={`output-panel__recent-dot output-panel__recent-dot--${cssStatus(r.status)}`}
                aria-hidden="true"
              />
              <span className="output-panel__recent-name">
                {r.customName ?? r.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ConsoleBodyProps {
  active: TrackedRun | null;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}

function ConsoleBody({ active, bodyRef }: ConsoleBodyProps): React.JSX.Element {
  const { t } = useTranslation();

  if (!active) {
    return (
      <div className="output-panel__body">
        <div className="output-panel__placeholder">
          {t("outputPanel.noSelection", "No run selected.")}
        </div>
      </div>
    );
  }

  if (active.error) {
    return (
      <div className="output-panel__body" ref={bodyRef}>
        <div className="output-line output-line--stderr" role="alert">
          {t(`web.run.${active.error}`, active.error)}
        </div>
      </div>
    );
  }

  const lines = active.output ?? [];
  if (lines.length === 0) {
    return (
      <div className="output-panel__body" ref={bodyRef}>
        <div className="output-panel__placeholder">
          {active.status === "running" || active.status === "pending"
            ? t("outputPanel.waiting", "Waiting for output…")
            : t("web.console.noOutput", "No output.")}
        </div>
      </div>
    );
  }

  return (
    <div className="output-panel__body" ref={bodyRef}>
      {lines.map((line, idx) => (
        <div
          key={`${active.executionId}-${idx}`}
          className={`output-line output-line--${line.stream}`}
        >
          {line.line}
        </div>
      ))}
    </div>
  );
}
