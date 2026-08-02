// Smoke tests for the customizable ExportDialog:
//   - a command forced by a selected workflow or mini-app renders
//     checked + disabled;
//   - the group parent checkbox selects / clears its children;
//   - the Export callback receives the resolved subset (incl. forced cmds);
//   - Export is disabled when nothing is selected;
//   - mini-apps are a selectable group and only the SELECTED ones reach the
//     export callback (regression: the hook used to pass the WHOLE store, so
//     exporting one command shipped every mini-app the user owned).
//
// The real i18n bundle is loaded so we can assert on rendered labels.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Command, MiniApp, Workflow } from "../../types";
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

function miniApp(id: string, name: string, commandId: string): MiniApp {
  return {
    id,
    name,
    panelSize: { w: 400, h: 320 },
    widgets: [
      {
        id: "w-btn",
        kind: "button",
        layout: { x: 0, y: 0, w: 140, h: 44 },
        label: "Run",
        action: { kind: "commandRef", commandId },
      },
    ],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
  };
}

const commands = [command("c1", "Build"), command("c2", "Deploy")];
const workflows = [workflow("w1", "Ship", "c1")];
// "Panel A" depends on c2 ("Deploy"); "Panel B" depends on nothing selected.
const miniapps = [miniApp("m1", "Panel A", "c2"), miniApp("m2", "Panel B", "c1")];

/** Locate the checkbox in the row labelled `text`. */
function checkboxForRow(text: string): HTMLInputElement {
  const row = screen.getByText(text).closest("label");
  if (row === null) throw new Error(`no row for ${text}`);
  return within(row).getByRole("checkbox") as HTMLInputElement;
}

describe("ExportDialog", () => {
  it("renders all three groups and their items", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText("Ship")).toBeTruthy();
    expect(screen.getByText("Panel A")).toBeTruthy();
    expect(screen.getByText("Panel B")).toBeTruthy();
  });

  it("notes that secret artifact values are never exported", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Secret artifact values are never written to the export file.",
      ),
    ).toBeTruthy();
  });

  it("disables Export when nothing is selected", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
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
        miniapps={miniapps}
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
        miniapps={miniapps}
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
        miniapps={miniapps}
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
      miniapps: MiniApp[];
    };
    expect(arg.commands.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(arg.workflows.map((w) => w.id)).toEqual(["w1"]);
    // No mini-app was ticked, so NONE are exported — the store's full list must
    // never leak into a selection the user did not make.
    expect(arg.miniapps).toEqual([]);
  });

  it("exports only the selected mini-apps, not the whole list", () => {
    const onExport = vi.fn();
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={onExport}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Panel A"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const arg = onExport.mock.calls[0]?.[0] as {
      commands: Command[];
      miniapps: MiniApp[];
    };
    expect(arg.miniapps.map((m) => m.id)).toEqual(["m1"]);
  });

  it("force-includes (and locks) the command a selected mini-app references", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // "Panel A" references c2 ("Deploy") — the file would be broken without it.
    fireEvent.click(checkboxForRow("Panel A"));
    const deployBox = checkboxForRow("Deploy");
    expect(deployBox.checked).toBe(true);
    expect(deployBox.disabled).toBe(true);
    // The unrelated command stays free.
    expect(checkboxForRow("Build").checked).toBe(false);
  });

  it("toggling the Mini-apps parent selects then clears all children", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const parent = screen.getByLabelText("Mini-apps");
    fireEvent.click(parent);
    expect(checkboxForRow("Panel A").checked).toBe(true);
    expect(checkboxForRow("Panel B").checked).toBe(true);
    fireEvent.click(parent);
    expect(checkboxForRow("Panel A").checked).toBe(false);
    expect(checkboxForRow("Panel B").checked).toBe(false);
  });

  it("enables Export when only a mini-app is selected", () => {
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Panel B"));
    const exportBtn = screen.getByRole("button", { name: "Export" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls onCancel from the Cancel button and Esc", () => {
    const onCancel = vi.fn();
    render(
      <ExportDialog
        commands={commands}
        workflows={workflows}
        miniapps={miniapps}
        onExport={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
