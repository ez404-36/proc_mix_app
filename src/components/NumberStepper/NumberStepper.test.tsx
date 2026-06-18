// Behavioural tests for the shared NumberStepper. Covers the plain numeric
// mode (clamping, no-NaN, stepper enable/disable) and the opt-in `allowEmpty`
// ("empty = no limit") mode used by the command-form timeout field
// (empty → null, clear → null, type → clamped, decrement disabled while empty).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumberStepper } from "./NumberStepper";

const labels = {
  ariaLabel: "Value",
  decrementLabel: "Decrement",
  incrementLabel: "Increment",
};

describe("NumberStepper — numeric mode", () => {
  it("increments / decrements within [min, max]", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper value={5} min={1} max={10} onChange={onChange} {...labels} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.click(screen.getByRole("button", { name: "Decrement" }));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it("disables the steppers at the bounds", () => {
    const { rerender } = render(
      <NumberStepper value={1} min={1} max={10} onChange={vi.fn()} {...labels} />,
    );
    expect(
      (screen.getByRole("button", { name: "Decrement" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      <NumberStepper value={10} min={1} max={10} onChange={vi.fn()} {...labels} />,
    );
    expect(
      (screen.getByRole("button", { name: "Increment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("clamps typed input and never emits NaN", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper value={5} min={1} max={10} onChange={onChange} {...labels} />,
    );
    const input = screen.getByLabelText("Value");
    fireEvent.change(input, { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.change(input, { target: { value: "" } });
    // Empty / non-numeric falls back to the floor (min) in numeric mode.
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});

describe("NumberStepper — allowEmpty mode", () => {
  it("clearing the field emits null", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        allowEmpty
        value={30}
        min={1}
        max={100}
        onChange={onChange}
        placeholder="No limit"
        {...labels}
      />,
    );
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("renders empty (placeholder) when value is null", () => {
    render(
      <NumberStepper
        allowEmpty
        value={null}
        min={1}
        max={100}
        onChange={vi.fn()}
        placeholder="No limit"
        {...labels}
      />,
    );
    const input = screen.getByLabelText("Value") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("No limit");
  });

  it("disables decrement while empty", () => {
    render(
      <NumberStepper
        allowEmpty
        value={null}
        min={1}
        max={100}
        onChange={vi.fn()}
        placeholder="No limit"
        {...labels}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Decrement" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("incrementing from empty lands on min", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        allowEmpty
        value={null}
        min={1}
        max={100}
        onChange={onChange}
        placeholder="No limit"
        {...labels}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("typing a number clamps to [min, max]", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        allowEmpty
        value={null}
        min={1}
        max={100}
        onChange={onChange}
        placeholder="No limit"
        {...labels}
      />,
    );
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "999" } });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });
});

describe("NumberStepper — allowEmpty + clearAtFloor", () => {
  it("keeps decrement enabled at the floor", () => {
    render(
      <NumberStepper
        allowEmpty
        clearAtFloor
        value={1}
        min={1}
        max={100}
        onChange={vi.fn()}
        placeholder="No limit"
        {...labels}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Decrement" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("decrementing at the floor clears to null", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        allowEmpty
        clearAtFloor
        value={1}
        min={1}
        max={100}
        onChange={onChange}
        placeholder="No limit"
        {...labels}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decrement" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("incrementing from empty still lands on min (1)", () => {
    const onChange = vi.fn();
    render(
      <NumberStepper
        allowEmpty
        clearAtFloor
        value={null}
        min={1}
        max={100}
        onChange={onChange}
        placeholder="No limit"
        {...labels}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
