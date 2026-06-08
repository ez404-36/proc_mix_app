import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import {
  isRegistered,
  register,
  unregister,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import {
  buildAcceleratorFromEvent,
  formatAccelerator,
} from "../../utils/accelerator";

interface ShortcutRowProps {
  label: string;
  description?: string;
  accelerator: string;
  defaultAccelerator: string;
  onChange: (accel: string) => void;
}

export function ShortcutRow({
  label,
  description,
  accelerator,
  defaultAccelerator,
  onChange,
}: ShortcutRowProps): ReactElement {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);

  const stopRecording = useCallback(() => setRecording(false), []);

  const commit = useCallback(
    async (next: string): Promise<void> => {
      if (next === accelerator) {
        setRecording(false);
        return;
      }
      // Probe registration to detect conflicts (best-effort).
      try {
        const already = await isRegistered(next);
        if (already) {
          // The previous accelerator (held by this same app) will be re-registered
          // by the useGlobalShortcut hook on the next render. Avoid a hard failure here.
          Message.warning(t("shortcutRow.alreadyInUse", { accel: next }));
          setRecording(false);
          return;
        }
        // Try a transient register to confirm the OS allows it.
        await register(next, noopHandler);
        await unregister(next);
      } catch (err) {
        console.error("[shortcut] probe register failed", next, err);
        Message.error(t("shortcutRow.registerFailed", { accel: next }));
        setRecording(false);
        return;
      }
      onChange(next);
      setRecording(false);
      Message.success(
        t("shortcutRow.updated", {
          accel: formatAccelerator(next).join(" + "),
        }),
      );
    },
    [accelerator, onChange, t],
  );

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stopRecording();
        return;
      }
      const next = buildAcceleratorFromEvent(e);
      if (!next) return; // wait for a valid combo
      void commit(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, commit, stopRecording]);

  const parts = formatAccelerator(accelerator);

  return (
    <div className="shortcut-row">
      <div className="shortcut-row__info">
        <div className="shortcut-row__label">{label}</div>
        {description ? (
          <div className="shortcut-row__desc">{description}</div>
        ) : null}
      </div>
      <div className="shortcut-row__combo">
        {recording ? (
          <span className="shortcut-row__recording">
            {t("shortcutRow.recording")}
          </span>
        ) : (
          parts.map((part, i) => (
            <span key={`${part}-${i}`} className="kbd">
              {part}
            </span>
          ))
        )}
      </div>
      <div className="shortcut-row__actions">
        {recording ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={stopRecording}
          >
            {t("common.cancel")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setRecording(true)}
            >
              {t("common.change")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onChange(defaultAccelerator)}
              disabled={accelerator === defaultAccelerator}
              title={t("shortcutRow.resetTooltip")}
            >
              {t("common.reset")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function noopHandler(_event: ShortcutEvent): void {
  // intentionally empty – only used to probe whether the OS accepts the combo
}
