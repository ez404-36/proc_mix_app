// Tests for the read-only CommandView modal: it surfaces the command's name,
// timeout, script, and variables, and wires the Edit / Run / Close footer
// callbacks plus Esc / backdrop dismissal. No reactflow here (unlike
// WorkflowView), so no canvas mock is needed.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import "../../i18n";
import type { Command } from "../../types";
import { CommandView } from "./CommandView";

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "c-1",
    name: "Build app",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

describe("CommandView", () => {
  it("renders nothing when command is null", () => {
    const { container } = render(
      <CommandView
        command={null}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders name, the no-timeout fallback, script, and the no-variables note", () => {
    render(
      <CommandView
        command={makeCommand()}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Build app")).toBeTruthy();
    // No timeoutSeconds set → "No limit" fallback.
    expect(screen.getByText("No limit")).toBeTruthy();
    expect(screen.getByText("echo build")).toBeTruthy();
    // No variables → the empty note.
    expect(screen.getByText("No variables")).toBeTruthy();
  });

  it("renders the timeout value and variable rows", () => {
    render(
      <CommandView
        command={makeCommand({
          timeoutSeconds: 30,
          variables: [
            { name: "HOST", defaultValue: "localhost" },
            { name: "TOKEN", sensitive: true, description: "API token" },
            { name: "PORT" },
          ],
        })}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("30 seconds")).toBeTruthy();
    expect(screen.getByText("HOST")).toBeTruthy();
    expect(screen.getByText("Default: localhost")).toBeTruthy();
    // Sensitive variable's value is hidden, never the default.
    expect(screen.getByText("TOKEN")).toBeTruthy();
    expect(screen.getByText("Sensitive — value hidden")).toBeTruthy();
    expect(screen.getByText("API token")).toBeTruthy();
    // No-default, non-sensitive variable → prompt-at-runtime hint.
    expect(screen.getByText("PORT")).toBeTruthy();
    expect(screen.getByText("Prompt at runtime")).toBeTruthy();
  });

  it("fires onEdit / onRun / onClose from the footer buttons", () => {
    const onEdit = vi.fn();
    const onRun = vi.fn();
    const onClose = vi.fn();
    const cmd = makeCommand();
    render(
      <CommandView
        command={cmd}
        onClose={onClose}
        onEdit={onEdit}
        onRun={onRun}
        onDelete={vi.fn()}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    expect(onEdit).toHaveBeenCalledWith(cmd);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });
    expect(onRun).toHaveBeenCalledWith(cmd);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc and on backdrop click", () => {
    const onClose = vi.fn();
    render(
      <CommandView
        command={makeCommand()}
        onClose={onClose}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = dialog.parentElement as HTMLElement;
    act(() => {
      fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
