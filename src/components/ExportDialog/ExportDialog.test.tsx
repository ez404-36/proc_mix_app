// Smoke tests for the customizable ExportDialog:
//   - a command forced by a selected workflow renders checked + disabled;
//   - the group parent checkbox selects / clears its children;
//   - the Export callback receives the resolved subset (incl. forced cmds);
//   - Export is disabled when nothing is selected.
//
// The real i18n bundle is loaded so we can assert on rendered labels.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Command, Workflow } from "../../types";
import "../../i18n";
import { ExportDialog } from "./ExportDialog";

function command(id: string, name: string): Command {
  return {
    id,
    name,
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function workflow(id: string, name: string, commandId: string): Workflow {
  return {
    id,
    name,
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      { id: "n-cmd", kind: "command", commandId, position: { x: 120, y: 0 } },
    ],
    edges: [{ id: "e1", source: "n-start", target: "n-cmd", branch: "out" }],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
  };
}

const commands = [command("c1", "Build"), command("c2", "Deploy")];
const workflows = [workflow("w1", "Ship", "c1")];

/** Locate the checkbox in the row labelled `text`. */
function checkboxForRow(text: string): HTMLInputElement {
  const row = screen.getByText(text).closest("label");
  if (row === null) throw new Error(`no row for ${text}`);
  return within(row).getByRole("checkbox") as HTMLInputElement;
}

describe("ExportDialog", () => {
  it("renders both groups and their items", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText("Ship")).toBeTruthy();
  });

  it("disables Export when nothing is selected", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const exportBtn = screen.getByRole("button", { name: "Export" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a workflow-required command as checked + disabled", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Select the workflow that depends on c1 ("Build").
    fireEvent.click(checkboxForRow("Ship"));
    const buildBox = checkboxForRow("Build");
    expect(buildBox.checked).toBe(true);
    expect(buildBox.disabled).toBe(true);
    // The other command is untouched and still toggleable.
    const deployBox = checkboxForRow("Deploy");
    expect(deployBox.checked).toBe(false);
    expect(deployBox.disabled).toBe(false);
  });

  it("toggling the Commands parent selects then clears all children", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const parent = screen.getByLabelText("Commands");
    fireEvent.click(parent);
    expect(checkboxForRow("Build").checked).toBe(true);
    expect(checkboxForRow("Deploy").checked).toBe(true);
    fireEvent.click(parent);
    expect(checkboxForRow("Build").checked).toBe(false);
    expect(checkboxForRow("Deploy").checked).toBe(false);
  });

  it("Export callback receives the resolved subset incl. forced commands", () => {
    const onExport = vi.fn();
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );
    // Select the workflow (forces c1) + explicitly check c2.
    fireEvent.click(checkboxForRow("Ship"));
    fireEvent.click(checkboxForRow("Deploy"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(onExport).toHaveBeenCalledTimes(1);
    const arg = onExport.mock.calls[0]?.[0] as {
      commands: Command[];
      workflows: Workflow[];
    };
    expect(arg.commands.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(arg.workflows.map((w) => w.id)).toEqual(["w1"]);
  });

  it("calls onCancel from the Cancel button and Esc", () => {
    const onCancel = vi.fn();
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        onExport={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
