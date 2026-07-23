import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import type { TFunction } from "i18next";
import { buildConsoleCopyMenu } from "../../utils/consoleClipboard";
import { useContextMenu } from "../ContextMenu";
import { AnsiText } from "../AnsiText";
import { StatusIcon } from "./StatusIcon";
import type { RunResult } from "./formState";

interface LiveRunOutputProps {
  result: RunResult;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClear: () => void;
  t: TFunction;
  envVars?: Record<string, string>;
}

/**
 * Render the inline live-run output panel. Collapsible header is always
 * visible; the body shows when expanded. Auto-scrolls to bottom on each
 * new line so the latest output stays visible during a long-running run.
 */
export function LiveRunOutput(props: LiveRunOutputProps): ReactElement {
  const { result, collapsed, onToggleCollapsed, onClear, t, envVars } = props;
  const envEntries = envVars ? Object.entries(envVars) : [];
  const { show } = useContextMenu();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lineCount = result.lines.length;

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildConsoleCopyMenu(bodyRef.current, t),
    });
  };

  // Auto-scroll the body to the bottom as new lines arrive. We don't
  // try to detect user-scroll-up here (the panel is small and short-
  // lived); a simple always-scroll matches the OutputPanel behaviour.
  useEffect(() => {
    if (collapsed) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lineCount, collapsed]);

  const statusLabel = t(`commandForm.output.status.${result.status}`);
  const headerClass =
    "command-form__output-header" +
    (collapsed ? " command-form__output-header--collapsed" : "");

  return (
    <div
      className="command-form__output"
      role="group"
      aria-label={t("commandForm.output.title")}
    >
      <div className={headerClass}>
        <span
          className={`command-form__output-status command-form__output-status--${result.status}`}
        >
          {statusLabel}
        </span>
        <StatusIcon status={result.status} t={t} />
        {result.exitCode !== null ? (
          <span className="command-form__output-meta">
            {t("commandForm.output.exitCode", { code: result.exitCode })}
          </span>
        ) : null}
        {result.durationMs !== null ? (
          <span className="command-form__output-meta">
            {t("commandForm.output.duration", { ms: result.durationMs })}
          </span>
        ) : null}
        <span className="command-form__output-spacer" />
        <div className="command-form__output-actions">
          <button
            type="button"
            onClick={onClear}
            disabled={
              result.lines.length === 0 &&
              result.status === "idle"
            }
          >
            {t("commandForm.output.clear")}
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
          >
            {collapsed ? "▾" : "▴"}
          </button>
        </div>
      </div>
      {!collapsed ? (
        <div
          ref={bodyRef}
          className="command-form__output-body"
          onContextMenu={handleContextMenu}
        >
          {envEntries.length > 0 && (
            <div className="command-form__output-env">
              <span className="command-form__output-env-label">
                {t("commandForm.output.envLabel", { defaultValue: "env" })}
              </span>
              {envEntries.map(([key, value]) => (
                <span key={key} className="command-form__output-env-entry">
                  <span className="command-form__output-env-key">{key}</span>
                  <span className="command-form__output-env-sep">=</span>
                  <span className="command-form__output-env-value">{value}</span>
                </span>
              ))}
            </div>
          )}
          {result.lines.length === 0 ? (
            <div className="command-form__output-empty">
              {/*
               * Empty-output copy depends on status:
               *   - idle (script not yet run) → instruct the user.
               *   - running (process spawned, no stdout/stderr yet)
               *     → "Waiting for output…" so the user knows we're
               *     live, not stuck. The previous "Click Run" copy
               *     was misleading here because the run was already
               *     in flight.
               *   - finished / failed / cancelled with zero output
               *     lines is a real (if rare) outcome (e.g. a script
               *     that only sets an exit code); we fall back to
               *     the idle copy because there's nothing more
               *     informative to say without surfacing the exit
               *     metadata, which the header already shows.
               */}
              {result.status === "running"
                ? t("outputPanel.waiting")
                : t("commandForm.output.placeholder")}
            </div>
          ) : (
            result.lines.map((line, idx) => (
              <div
                key={idx}
                className={`command-form__output-line command-form__output-line--${line.stream}`}
              >
                <AnsiText text={line.text} />
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
