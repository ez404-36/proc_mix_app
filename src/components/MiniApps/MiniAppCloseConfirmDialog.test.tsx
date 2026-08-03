import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import "../../i18n";
import { MiniAppCloseConfirmDialog } from "./MiniAppCloseConfirmDialog";

function renderDialog(
  overrides: Partial<Parameters<typeof MiniAppCloseConfirmDialog>[0]> = {},
): { onConfirm: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    render(
      <MiniAppCloseConfirmDialog
        open
        processCount={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...overrides}
      />,
    );
  });
  return { onConfirm, onCancel };
}

describe("MiniAppCloseConfirmDialog", () => {
  it("renders nothing when open is false", () => {
    act(() => {
      render(
        <MiniAppCloseConfirmDialog
          open={false}
          processCount={1}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the process count in the message", () => {
    renderDialog({ processCount: 3 });
    expect(screen.getByText(/3 active processes/)).toBeTruthy();
  });

  it("defaults the kill-toggle to ON", () => {
    renderDialog();
    const toggle = screen.getByRole("switch", {
      name: "Kill all child processes",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("calls onConfirm with true when confirmed without touching the toggle", () => {
    const { onConfirm } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    });
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("calls onConfirm with false after the toggle is switched off", () => {
    const { onConfirm } = renderDialog();
    act(() => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Kill all child processes" }),
      );
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    });
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const { onCancel, onConfirm } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const { onCancel, onConfirm } = renderDialog();
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    act(() => {
      if (backdrop) fireEvent.click(backdrop);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("resets the toggle to ON every time the dialog re-opens", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <MiniAppCloseConfirmDialog
        open
        processCount={1}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    act(() => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Kill all child processes" }),
      );
    });
    expect(
      screen
        .getByRole("switch", { name: "Kill all child processes" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    act(() => {
      rerender(
        <MiniAppCloseConfirmDialog
          open={false}
          processCount={1}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
    });
    act(() => {
      rerender(
        <MiniAppCloseConfirmDialog
          open
          processCount={1}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(
      screen
        .getByRole("switch", { name: "Kill all child processes" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
