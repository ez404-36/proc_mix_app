import type { ReactElement } from "react";
import type { TFunction } from "i18next";
import { SpinnerIcon, StatusCheckIcon, StatusCrossIcon } from "../icons";
import type { RunStatus } from "./formState";

interface StatusIconProps {
  status: RunStatus;
  t: TFunction;
}

/**
 * Render a status icon for the live-run output header.
 *   - running   → animated CSS-only spinner (accent color)
 *   - finished  → green checkmark (SVG)
 *   - failed    → red cross (SVG)
 *   - cancelled → no icon (user already chose to stop; the badge text says so)
 *   - idle      → no icon
 *
 * Icons are inline SVGs (no dependency, no emoji). Color uses CSS classes so
 * theme switching follows the rest of the app. Each icon carries an
 * `aria-label` for screen readers.
 */
export function StatusIcon(props: StatusIconProps): ReactElement | null {
  const { status, t } = props;
  switch (status) {
    case "running":
      return (
        <span
          className="command-form__output-icon command-form__output-icon--running"
          role="img"
          aria-label={t("commandForm.output.status.running")}
        >
          <SpinnerIcon />
        </span>
      );
    case "finished":
      return (
        <span
          className="command-form__output-icon command-form__output-icon--finished"
          role="img"
          aria-label={t("commandForm.output.status.finished")}
        >
          <StatusCheckIcon />
        </span>
      );
    case "failed":
    case "timedOut":
      return (
        <span
          className="command-form__output-icon command-form__output-icon--failed"
          role="img"
          aria-label={t(
            status === "timedOut"
              ? "commandForm.output.status.timedOut"
              : "commandForm.output.status.failed",
          )}
        >
          <StatusCrossIcon />
        </span>
      );
    case "idle":
    case "cancelled":
    default:
      return null;
  }
}
