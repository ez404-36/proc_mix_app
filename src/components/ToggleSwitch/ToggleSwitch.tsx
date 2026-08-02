// iOS-style on/off switch.
//
// A button with `role="switch"` + `aria-checked` (the accessible pattern for a
// toggle), styled as a sliding pill (`toggle-switch__*` BEM family in
// theme.css). Used for the HTTP server's run toggle in the panel header.
//
// Controlled: the parent owns `checked` and flips it in `onChange`. `disabled`
// blocks interaction while a transition is in flight (e.g. the server is
// starting/stopping).

import type { CSSProperties, ReactElement } from "react";

interface ToggleSwitchProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the requested next state when the user toggles. */
  onChange: (next: boolean) => void;
  /** Accessible label (the switch has no visible text of its own). */
  ariaLabel: string;
  /** When true, the switch is non-interactive and dimmed. */
  disabled?: boolean;
  /**
   * Custom ON-state color (a `var(--color-...)` token or hex value). Only
   * affects the `checked` appearance; the OFF state is always the neutral
   * `--color-text-muted`/`--color-border` regardless of this prop.
   */
  color?: string;
  /**
   * ON-state visual treatment. `"fill"` (default) is the original solid
   * track + white thumb. `"outline"` renders a transparent track with a
   * colored border and a colored thumb instead.
   */
  variant?: "fill" | "outline";
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  color,
  variant = "fill",
}: ToggleSwitchProps): ReactElement {
  const customizeOn = checked && (color !== undefined || variant !== "fill");
  let trackStyle: CSSProperties | undefined;
  let thumbStyle: CSSProperties | undefined;

  if (customizeOn) {
    if (variant === "outline") {
      trackStyle = {
        background: "transparent",
        borderColor: color ?? "var(--app-color-run)",
      };
      thumbStyle = { background: color ?? "var(--app-color-run)" };
    } else {
      trackStyle = { background: color, borderColor: color };
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`toggle-switch${checked ? " is-on" : ""}`}
      style={trackStyle}
      onClick={() => onChange(!checked)}
    >
      <span
        className="toggle-switch__thumb"
        aria-hidden="true"
        style={thumbStyle}
      />
    </button>
  );
}
