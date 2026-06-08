// Numeric input with ghost-button steppers stacked vertically to the RIGHT
// of the field ([input] [+ / −], + on top).
//
// Extracted from the command form's timeout field so every numeric field in
// the app shares the same look: the browser's native number-spinner arrows
// are hidden (they don't match the app's button language) and replaced with
// `.btn--ghost` steppers. The text input keeps `type="number"` so direct
// typing and validation still work.
//
// This variant operates on a plain numeric value clamped to `[min, max]`.
// (The command-form timeout field has bespoke "empty = no limit" semantics
// and keeps its own markup; it shares only the CSS class names below.)

import type { ReactElement } from "react";

interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Accessible label for the text input. */
  ariaLabel: string;
  /** Accessible label / tooltip for the decrement button. */
  decrementLabel: string;
  /** Accessible label / tooltip for the increment button. */
  incrementLabel: string;
  /**
   * When set, the displayed value is left-padded with zeros to this many
   * digits (e.g. `2` shows `9` as `09`). Used by the time picker so hours /
   * minutes read as `HH` / `MM`. The input switches to `type="text"`
   * (`inputMode="numeric"`) because a native number input can't render a
   * leading zero. Omit for a plain numeric field.
   */
  padLength?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  ariaLabel,
  decrementLabel,
  incrementLabel,
  padLength,
}: NumberStepperProps): ReactElement {
  const commit = (next: number): void => {
    onChange(clamp(Math.trunc(next), min, max));
  };

  const padded =
    padLength !== undefined ? String(value).padStart(padLength, "0") : value;

  return (
    <div className="number-stepper">
      <input
        // A native number input can't render a leading zero, so the padded
        // variant uses a numeric text input instead.
        type={padLength !== undefined ? "text" : "number"}
        inputMode="numeric"
        className="input number-stepper__input"
        min={min}
        max={max}
        step={step}
        value={padded}
        aria-label={ariaLabel}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          // Empty / non-numeric input falls back to the floor rather than
          // producing NaN; the field never holds an invalid value.
          commit(Number.isNaN(parsed) ? min : parsed);
        }}
      />
      {/* Steppers stacked to the right of the input, + on top of −. */}
      <div className="number-stepper__buttons">
        <button
          type="button"
          className="btn btn--ghost btn--icon number-stepper__step"
          onClick={() => commit(value + step)}
          disabled={value >= max}
          aria-label={incrementLabel}
          title={incrementLabel}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon number-stepper__step"
          onClick={() => commit(value - step)}
          disabled={value <= min}
          aria-label={decrementLabel}
          title={decrementLabel}
        >
          −
        </button>
      </div>
    </div>
  );
}
