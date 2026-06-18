// Numeric input with ghost-button steppers stacked vertically to the RIGHT
// of the field ([input] [+ / −], + on top).
//
// Extracted from the command form's timeout field so every numeric field in
// the app shares the same look: the browser's native number-spinner arrows
// are hidden (they don't match the app's button language) and replaced with
// `.btn--ghost` steppers. The text input keeps `type="number"` so direct
// typing and validation still work.
//
// Two modes:
//   - Default: operates on a plain numeric value clamped to `[min, max]`;
//     the field is never empty and never emits NaN/null.
//   - `allowEmpty`: the value may be `null` ("empty = no limit"). An empty
//     input renders the placeholder, emits `null`, and the decrement button
//     is disabled while empty (so it can't go below `min`). This powers the
//     command-form timeout field.

import type { ReactElement } from "react";

interface NumberStepperBaseProps {
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

interface NumberStepperNumericProps extends NumberStepperBaseProps {
  allowEmpty?: false;
  value: number;
  onChange: (value: number) => void;
}

interface NumberStepperNullableProps extends NumberStepperBaseProps {
  /**
   * Opt-in "empty = no limit" mode: `value`/`onChange` accept `null`, an
   * empty input shows the `placeholder`, and decrementing is disabled while
   * empty.
   */
  allowEmpty: true;
  value: number | null;
  onChange: (value: number | null) => void;
  /** Placeholder shown when the value is `null` (e.g. "No limit"). */
  placeholder?: string;
  /**
   * When `true`, decrementing AT the floor (`value === min`) clears the field
   * to `null` ("no limit") instead of disabling the "−" button. Incrementing
   * from empty still lands on `min`. Use for fields where `min` is the lowest
   * meaningful value and the step below it means "unset" (e.g. table
   * `maxColumns`: min 1, "−" at 1 → no limit).
   */
  clearAtFloor?: boolean;
}

type NumberStepperProps = NumberStepperNumericProps | NumberStepperNullableProps;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function NumberStepper(props: NumberStepperProps): ReactElement {
  const {
    value,
    min,
    max,
    step = 1,
    ariaLabel,
    decrementLabel,
    incrementLabel,
    padLength,
  } = props;

  const allowEmpty = props.allowEmpty === true;
  const isEmpty = allowEmpty && value === null;
  const clearAtFloor = props.allowEmpty === true && props.clearAtFloor === true;

  const commit = (next: number): void => {
    props.onChange(clamp(Math.trunc(next), min, max));
  };

  // From an empty value the first "+" lands on `min` (the floor), matching
  // the timeout field's original "empty → 1" behaviour; otherwise step from
  // the current value. Decrement is disabled while empty, so it always has a
  // concrete value to step down from.
  const increment = (): void => commit(value === null ? min : value + step);
  const decrement = (): void => {
    // In `clearAtFloor` mode, stepping down from the floor clears the field
    // ("no limit") instead of clamping back to `min`.
    if (clearAtFloor && value !== null && value <= min) {
      props.onChange(null);
      return;
    }
    commit((value ?? min) - step);
  };

  const handleInput = (raw: string): void => {
    if (props.allowEmpty === true && raw.trim() === "") {
      props.onChange(null);
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    // Non-numeric input falls back to the floor rather than producing NaN;
    // the field never holds an invalid value.
    commit(Number.isNaN(parsed) ? min : parsed);
  };

  const displayValue =
    value === null
      ? ""
      : padLength !== undefined
        ? String(value).padStart(padLength, "0")
        : value;

  // Disabled only while empty; at the floor it's still enabled in
  // `clearAtFloor` mode (it clears the field) but disabled otherwise.
  const decrementDisabled =
    isEmpty || (!clearAtFloor && value !== null && value <= min);
  const incrementDisabled = value !== null && value >= max;

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
        value={displayValue}
        aria-label={ariaLabel}
        placeholder={props.allowEmpty === true ? props.placeholder : undefined}
        onChange={(e) => handleInput(e.target.value)}
      />
      {/* Steppers stacked to the right of the input, + on top of −. */}
      <div className="number-stepper__buttons">
        <button
          type="button"
          className="btn btn--ghost btn--icon number-stepper__step"
          onClick={increment}
          disabled={incrementDisabled}
          aria-label={incrementLabel}
          title={incrementLabel}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon number-stepper__step"
          onClick={decrement}
          disabled={decrementDisabled}
          aria-label={decrementLabel}
          title={decrementLabel}
        >
          −
        </button>
      </div>
    </div>
  );
}
