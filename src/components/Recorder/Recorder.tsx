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

import { useEffect, useRef, useState, type ReactElement } from "react";
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
  isCaptureUnsupportedError,
  startProcessCapture,
  stopProcessCapture,
  subscribeCaptureEvents,
} from "../../utils/processCapture";
import {
  resolveCaptureConsent,
  type RequestConsent,
} from "../../utils/processCaptureConsent";
import { ConfirmDialog } from "../ConfirmDialog";

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

  // Consent dialog plumbing: `resolveCaptureConsent` is handed a
  // `requestConsent` that opens the dialog and resolves when the user
  // answers. We stash the resolver so the dialog buttons can settle it.
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolverRef = useRef<((accepted: boolean) => void) | null>(null);

  // Resolve platform once on mount.
  useEffect(() => {
    let active = true;
    void getPlatform().then((p) => {
      if (active) setSupported(p === "windows");
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

    try {
      await startProcessCapture();
      setRecording(true);
    } catch (err) {
      if (isCaptureUnsupportedError(err)) {
        setSupported(false);
        return;
      }
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
            {supported === false && (
              <span className="badge badge--muted recorder__badge">
                {t("processCapture.unsupportedBadge")}
              </span>
            )}
          </h1>
          <p className="view__subtitle">{t("processCapture.subtitle")}</p>
        </div>
      </header>

      {supported === false ? (
        <p className="view__empty view__empty--notice">
          {t("processCapture.unsupported")}
        </p>
      ) : (
        <>
          <div className="recorder__toolbar">
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
                {t("processCapture.recording")}
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
