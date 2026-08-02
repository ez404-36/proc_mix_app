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

  it("renders with no inline style when color/variant are not provided", () => {
    const { rerender } = render(
      <ToggleSwitch checked={false} onChange={() => {}} ariaLabel="Server" />,
    );
    const sw = screen.getByRole("switch", { name: "Server" });
    expect(sw.getAttribute("style")).toBeNull();

    rerender(
      <ToggleSwitch checked onChange={() => {}} ariaLabel="Server" />,
    );
    expect(sw.getAttribute("style")).toBeNull();
  });

  it("does not leak custom color into the OFF state", () => {
    render(
      <ToggleSwitch
        checked={false}
        onChange={() => {}}
        ariaLabel="Server"
        color="var(--color-danger)"
        variant="outline"
      />,
    );
    const sw = screen.getByRole("switch", { name: "Server" });
    expect(sw.className).not.toContain("is-on");
    expect(sw.getAttribute("style")).toBeNull();
  });

  it("applies a custom fill color to the track while keeping the thumb white", () => {
    render(
      <ToggleSwitch
        checked
        onChange={() => {}}
        ariaLabel="Server"
        variant="fill"
        color="var(--color-danger)"
      />,
    );
    const sw = screen.getByRole("switch", { name: "Server" });
    expect(sw.style.background).toBe("var(--color-danger)");
    const thumb = sw.querySelector(".toggle-switch__thumb");
    expect(thumb).not.toBeNull();
    expect((thumb as HTMLElement).getAttribute("style")).toBeNull();
  });

  it("applies an outline treatment with a colored border and thumb", () => {
    render(
      <ToggleSwitch
        checked
        onChange={() => {}}
        ariaLabel="Server"
        variant="outline"
        color="var(--color-danger)"
      />,
    );
    const sw = screen.getByRole("switch", { name: "Server" });
    expect(sw.style.background).toBe("transparent");
    expect(sw.style.borderColor).toBe("var(--color-danger)");
    const thumb = sw.querySelector(".toggle-switch__thumb") as HTMLElement;
    expect(thumb.style.background).toBe("var(--color-danger)");
  });
});
