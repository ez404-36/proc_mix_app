// Tests for ToggleSwitch: ARIA state, click toggling, and disabled behaviour.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ToggleSwitch } from "./ToggleSwitch";

describe("ToggleSwitch", () => {
  it("exposes the switch role with aria-checked reflecting state", () => {
    const { rerender } = render(
      <ToggleSwitch checked={false} onChange={() => {}} ariaLabel="Server" />,
    );
    const sw = screen.getByRole("switch", { name: "Server" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    rerender(
      <ToggleSwitch checked onChange={() => {}} ariaLabel="Server" />,
    );
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("is-on");
  });

  it("calls onChange with the inverted value when clicked", () => {
    const onChange = vi.fn();
    render(
      <ToggleSwitch checked={false} onChange={onChange} ariaLabel="Server" />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire onChange while disabled", () => {
    const onChange = vi.fn();
    render(
      <ToggleSwitch
        checked={false}
        onChange={onChange}
        ariaLabel="Server"
        disabled
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
