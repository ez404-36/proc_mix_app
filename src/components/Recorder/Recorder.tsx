// Top-level "Recorder" view: the Process Capture UI.
//
// Lets the user record commands launched by other apps and (Step 7) turn
// the selected ones into ProcMix commands/workflows. The captured stream is
// ephemeral — it lives in `captureStore` only and is wiped on stop and on
// leaving this view (see `docs/process-capture.md`).
//
// Gating:
//   - Windows-only: on other platforms the controls are replaced by an
//     "unsupported" notice. We also defend against a non-Windows start by
//     treating the `CAPTURE_UNSUPPORTED` sentinel as the unsupported state.
//   - Opt-in: the first Start shows a one-time consent dialog
//     (`resolveCaptureConsent`); capture never begins without it.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { useShallow } from "zustand/react/shallow";

import { useCaptureStore } from "../../stores/captureStore";
import {
  saveCaptureAsCommand,
  saveCaptureAsWorkflow,
} from "../../services/recordingActions";
import { useUIStore } from "../../stores/uiStore";
import { getPlatform } from "../../utils/platform";
import {
  isCaptureRequiresPrivilegeError,
  isCaptureUnsupportedError,
  listCaptureTargets,
  startProcessCapture,
  stopProcessCapture,
  subscribeCaptureEvents,
} from "../../utils/processCapture";
import type { CaptureScope, CaptureTarget } from "../../types/capture";
import {
  resolveCaptureConsent,
  type RequestConsent,
} from "../../utils/processCaptureConsent";
import { ConfirmDialog } from "../ConfirmDialog";
import { Dropdown, type DropdownOption } from "../Dropdown";

export function Recorder(): ReactElement {
  const { t } = useTranslation();

  const recording = useCaptureStore((s) => s.recording);
  const rows = useCaptureStore((s) => s.rows);
  const selectedIds = useCaptureStore((s) => s.selectedIds);
  const { setRecording, addEvent, toggleSelected, setAllSelected, clear } =
    useCaptureStore(
      useShallow((s) => ({
        setRecording: s.setRecording,
        addEvent: s.addEvent,
        toggleSelected: s.toggleSelected,
        setAllSelected: s.setAllSelected,
        clear: s.clear,
      })),
    );

  const processCaptureEnabled = useUIStore((s) => s.processCaptureEnabled);
  const setProcessCaptureEnabled = useUIStore(
    (s) => s.setProcessCaptureEnabled,
  );

  // `null` until the platform check resolves; then true/false.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // Capture scope: the chosen target apps' PIDs. Empty = "all processes".
  // Multi-select so the user can record several apps at once (the backend
  // `Subtree` scope already takes multiple roots).
  const [targetPids, setTargetPids] = useState<number[]>([]);
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  // Label of the app(s) the active session is scoped to (for the subtitle
  // while recording, when the selector is hidden); `null` when scope is "all".
  const [activeScopeLabel, setActiveScopeLabel] = useState<string | null>(null);

  // Consent dialog plumbing: `resolveCaptureConsent` is handed a
  // `requestConsent` that opens the dialog and resolves when the user
  // answers. We stash the resolver so the dialog buttons can settle it.
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolverRef = useRef<((accepted: boolean) => void) | null>(null);

  // Resolve platform once on mount. Windows (ETW) and Linux (netlink
  // cn_proc) both have a capture backend; the backend stays authoritative,
  // so if its `start` fails (e.g. missing CAP_NET_ADMIN on Linux) the error
  // surfaces via `handleStart` rather than this gate.
  useEffect(() => {
    let active = true;
    void getPlatform().then((p) => {
      if (active) setSupported(p === "windows" || p === "linux");
    });
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to capture events for the lifetime of the view. Events flow
  // into the store regardless of which screen is showing, but the listener
  // only needs to exist while the recorder is mounted.
  useEffect(() => {
    const unsub = subscribeCaptureEvents(addEvent);
    return unsub;
  }, [addEvent]);

  // On unmount: stop any in-flight session and wipe the ephemeral stream so
  // captured command lines never linger after the user navigates away.
  useEffect(() => {
    return () => {
      void stopProcessCapture().catch(() => {
        // Best-effort: nothing actionable if stop fails on teardown.
      });
      clear();
    };
  }, [clear]);

  const requestConsent: RequestConsent = () =>
    new Promise<boolean>((resolve) => {
      consentResolverRef.current = resolve;
      setConsentOpen(true);
    });

  const settleConsent = (accepted: boolean): void => {
    setConsentOpen(false);
    const resolve = consentResolverRef.current;
    consentResolverRef.current = null;
    resolve?.(accepted);
  };

  // Options for the scope dropdown: one per enumerable process. "All
  // processes" is represented by an EMPTY selection (the placeholder), not a
  // togglable option, so it can't be combined with specific apps.
  const scopeOptions = useMemo<DropdownOption[]>(
    () =>
      targets.map((tgt) => ({
        value: String(tgt.pid),
        label: tgt.name,
        description: `PID ${tgt.pid}`,
      })),
    [targets],
  );

  const selectedScopeValues = useMemo(
    () => targetPids.map(String),
    [targetPids],
  );

  // Human-readable label for an active scope, used in the recording subtitle.
  const scopeLabelFor = (pids: number[]): string | null => {
    if (pids.length === 0) return null;
    if (pids.length === 1) {
      const only = targets.find((tgt) => tgt.pid === pids[0]);
      return only?.name ?? String(pids[0]);
    }
    return t("processCapture.scope.activeCount", { count: pids.length });
  };

  // Load the list of processes the user can scope to. Called when the picker
  // is opened; shows a loader meanwhile so the user isn't shown a
  // misleadingly-short list while the async `/proc` walk is in flight.
  // Best-effort: on platforms without target enumeration the list is empty.
  const refreshTargets = async (): Promise<void> => {
    setTargetsLoading(true);
    try {
      setTargets(await listCaptureTargets());
    } catch {
      setTargets([]);
    } finally {
      setTargetsLoading(false);
    }
  };

  // Open handler for the scope dropdown: load the process list the FIRST time
  // it is opened (and refresh on each open since the list goes stale fast).
  const handleScopeOpen = (open: boolean): void => {
    if (open) void refreshTargets();
  };

  const handleStart = async (): Promise<void> => {
    setStartError(null);
    const consent = await resolveCaptureConsent(
      {
        isEnabled: () => processCaptureEnabled,
        setEnabled: setProcessCaptureEnabled,
      },
      requestConsent,
    );
    if (!consent.granted) return;

    // Empty selection → "all processes"; otherwise scope to the chosen apps'
    // subtrees (the base "record these apps and their children" scenario).
    const scope: CaptureScope =
      targetPids.length === 0
        ? { mode: "all" }
        : { mode: "subtree", roots: targetPids };

    try {
      await startProcessCapture(scope);
      setActiveScopeLabel(scopeLabelFor(targetPids));
      setRecording(true);
    } catch (err) {
      if (isCaptureUnsupportedError(err)) {
        setSupported(false);
        return;
      }
      // Linux: the feature is supported but the kernel proc connector bind
      // was denied (missing CAP_NET_ADMIN). Show a tailored hint guiding the
      // user to grant the capability, NOT the generic ETW/admin message.
      if (isCaptureRequiresPrivilegeError(err)) {
        setStartError(t("processCapture.requiresPrivilege"));
        return;
      }
      // Surface the real cause for diagnosis. On Windows the dominant failure
      // mode is the ETW trace session needing administrator rights, so the OS
      // returns "access denied" here.
      console.error("start_process_capture failed:", err);
      setStartError(t("processCapture.startFailed"));
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await stopProcessCapture();
    } finally {
      setRecording(false);
    }
  };

  const selectedRows = rows.filter((r) => selectedIds.has(r.id));

  const handleSaveCommands = (): void => {
    if (selectedRows.length === 0) return;
    const created = saveCaptureAsCommand(selectedRows);
    Message.success(
      t("processCapture.savedCommands", { count: created.length }),
    );
    setAllSelected(false);
  };

  const handleSaveWorkflow = (): void => {
    if (selectedRows.length === 0) return;
    const name = t("processCapture.defaultWorkflowName");
    const workflow = saveCaptureAsWorkflow(name, selectedRows);
    if (workflow) {
      Message.success(
        t("processCapture.savedWorkflow", { name: workflow.name }),
      );
      setAllSelected(false);
    }
  };

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;

  return (
    <section className="view view--recorder">
      <header className="view__header">
        <div>
          <h1 className="view__title">
            {t("processCapture.title")}
            <span className="recorder__experimental">
              {t("processCapture.experimental")}
            </span>
            {supported === false && (
              <span className="badge badge--muted recorder__badge">
                {t("processCapture.unsupportedBadge")}
              </span>
            )}
          </h1>
          <p className="view__subtitle">{t("processCapture.subtitle")}</p>
          {supported !== false && (
            <p className="recorder__explainer">
              {t("processCapture.explainer")}
            </p>
          )}
        </div>
      </header>

      {supported === false ? (
        <p className="view__empty view__empty--notice">
          {t("processCapture.unsupported")}
        </p>
      ) : (
        <>
          <div className="recorder__toolbar">
            {!recording && (
              <Dropdown
                multiple
                searchable
                ariaLabel={t("processCapture.scope.label")}
                className="recorder__scope-select"
                popupClassName="recorder__scope-popup"
                placeholder={t("processCapture.scope.all")}
                searchPlaceholder={t("processCapture.scope.search")}
                options={scopeOptions}
                values={selectedScopeValues}
                onChangeMultiple={(vals) =>
                  setTargetPids(vals.map(Number))
                }
                onOpenChange={handleScopeOpen}
                loading={targetsLoading}
                loadingLabel={t("processCapture.scope.loading")}
                // Single-select props are unused in multi mode but required by
                // the shared component's signature.
                value=""
                onChange={() => {}}
              />
            )}

            {recording ? (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void handleStop()}
              >
                {t("processCapture.stop")}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleStart()}
                disabled={supported === null}
              >
                {t("processCapture.start")}
              </button>
            )}

            {recording && (
              <span className="recorder__status" aria-live="polite">
                {activeScopeLabel
                  ? t("processCapture.scope.active", {
                      name: activeScopeLabel,
                    })
                  : t("processCapture.recording")}
              </span>
            )}

            <div className="recorder__toolbar-spacer" />

            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setAllSelected(!allSelected)}
              disabled={rows.length === 0}
            >
              {allSelected
                ? t("processCapture.selectNone")
                : t("processCapture.selectAll")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={clear}
              disabled={rows.length === 0}
            >
              {t("processCapture.clear")}
            </button>
          </div>

          {startError && <p className="view__error">{startError}</p>}

          {selectedIds.size > 0 && (
            <div className="recorder__selection">
              <span className="recorder__selection-count">
                {t("processCapture.selectedCount", { count: selectedIds.size })}
              </span>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleSaveCommands}
              >
                {t("processCapture.saveAsCommand", { count: selectedIds.size })}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleSaveWorkflow}
                disabled={selectedIds.size < 2}
              >
                {t("processCapture.saveAsWorkflow")}
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <p className="view__empty">
              {recording
                ? t("processCapture.emptyRecording")
                : t("processCapture.empty")}
            </p>
          ) : (
            <ul className="recorder__list">
              {rows.map((row) => {
                const checked = selectedIds.has(row.id);
                return (
                  <li key={row.id} className="recorder__row">
                    <label className="recorder__row-label">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelected(row.id)}
                      />
                      <span className="recorder__row-command">
                        {row.commandLine}
                      </span>
                      <span className="recorder__row-image">{row.image}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={consentOpen}
        title={t("processCapture.consent.title")}
        message={t("processCapture.consent.message")}
        confirmLabel={t("processCapture.consent.accept")}
        cancelLabel={t("processCapture.consent.decline")}
        onConfirm={() => settleConsent(true)}
        onCancel={() => settleConsent(false)}
      />
    </section>
  );
}
