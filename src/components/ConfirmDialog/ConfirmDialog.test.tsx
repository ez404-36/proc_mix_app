import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import "../../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(
  overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {},
): { onConfirm: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    render(
      <ConfirmDialog
        open
        title="Clear editor?"
        message="Discard unsaved changes?"
        confirmLabel="Clear"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...overrides}
      />,
    );
  });
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("renders the title and message when open", () => {
    renderDialog();
    expect(screen.getByText("Clear editor?")).toBeTruthy();
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders nothing when open is false", () => {
    act(() => {
      render(
        <ConfirmDialog
          open={false}
          title="Clear editor?"
          message="Discard unsaved changes?"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Clear editor?")).toBeNull();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onConfirm when Enter is pressed", () => {
    const { onConfirm } = renderDialog();
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does NOT close when Escape is pressed", () => {
    const { onCancel, onConfirm } = renderDialog();
    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    // The dialog's parent is the backdrop; clicking it (target === backdrop)
    // cancels, while clicking inside the dialog body does not.
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    act(() => {
      if (backdrop) fireEvent.click(backdrop);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not cancel when clicking inside the dialog body", () => {
    const { onCancel } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByText("Discard unsaved changes?"));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("falls back to the localized common.confirm label when none is given", () => {
    renderDialog({ confirmLabel: undefined });
    // en locale: common.confirm = "Confirm".
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});
