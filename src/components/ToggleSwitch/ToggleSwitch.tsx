// iOS-style on/off switch.
//
// A button with `role="switch"` + `aria-checked` (the accessible pattern for a
// toggle), styled as a sliding pill (`toggle-switch__*` BEM family in
// theme.css). Used for the HTTP server's run toggle in the panel header.
//
// Controlled: the parent owns `checked` and flips it in `onChange`. `disabled`
// blocks interaction while a transition is in flight (e.g. the server is
// starting/stopping).

import type { ReactElement } from "react";

interface ToggleSwitchProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the requested next state when the user toggles. */
  onChange: (next: boolean) => void;
  /** Accessible label (the switch has no visible text of its own). */
  ariaLabel: string;
  /** When true, the switch is non-interactive and dimmed. */
  disabled?: boolean;
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: ToggleSwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`toggle-switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-switch__thumb" aria-hidden="true" />
    </button>
  );
}
