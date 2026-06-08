// Tests for the ImportDialog: it reuses the shared SelectionTree (covered by
// ExportDialog.test) and adds the import-specific duplicate resolution. We
// focus on what is unique here:
//   - a NAME collision shows a notice + rename/skip choice (default rename);
//   - a SCRIPT-only collision shows a warning with NO action;
//   - the notice only appears once the row is checked;
//   - the resolved ImportSelection reflects rename (default) vs skip;
//   - selecting a workflow force-includes its command (shared logic, smoke).
//
// The real i18n bundle is loaded so we can assert on rendered labels.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Command } from "../../types";
import type { ProcMixExport } from "../../utils/dataTransfer";
import { EXPORT_VERSION } from "../../utils/dataTransfer";
import type { ImportSelection } from "../../services/dataImport";
import "../../i18n";
import { ImportDialog } from "./ImportDialog";

function existing(id: string, name: string, script: string): Command {
  return {
    id,
    name,
    script,
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function envelope(): ProcMixExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands: [
      { id: "c1", name: "Build", script: "npm run build", tags: [], runAsAdmin: false },
      { id: "c2", name: "Fresh", script: "echo new", tags: [], runAsAdmin: false },
    ],
    workflows: [
      {
        id: "w1",
        name: "Ship",
        nodes: [
          { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
          {
            id: "n-cmd",
            kind: "command",
            commandId: "c1",
            position: { x: 120, y: 0 },
          },
        ],
        edges: [
          { id: "e1", source: "n-start", target: "n-cmd", branch: "out" },
        ],
        tags: [],
      },
    ],
  };
}

// c1 ("Build") collides with an existing library command BY NAME (different
// script). c2 ("Fresh", "echo new") collides BY SCRIPT only with "Other".
const library = [
  existing("E1", "Build", "totally different"),
  existing("E2", "Other", "echo new"),
];

function checkboxForRow(text: string): HTMLInputElement {
  const row = screen.getByText(text).closest("label");
  if (row === null) throw new Error(`no row for ${text}`);
  return within(row).getByRole("checkbox") as HTMLInputElement;
}

describe("ImportDialog", () => {
  it("renders the file's commands and workflows", () => {
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Fresh")).toBeTruthy();
    expect(screen.getByText("Ship")).toBeTruthy();
  });

  it("shows the name-duplicate notice only after the colliding row is checked", () => {
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Not checked yet → no notice.
    expect(
      screen.queryByText("A command with this name already exists"),
    ).toBeNull();
    fireEvent.click(checkboxForRow("Build"));
    expect(
      screen.getByText("A command with this name already exists"),
    ).toBeTruthy();
  });

  it("defaults a checked name-duplicate to Keep-with-a-new-name (rename)", () => {
    const onImport = vi.fn();
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={onImport}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Build"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    const selection = onImport.mock.calls[0]?.[0] as ImportSelection;
    // Rename default → c1 IS imported, under a fresh unique name.
    expect([...selection.commandIds]).toEqual(["c1"]);
    expect(selection.rename.get("c1")).toBe("Build (2)");
  });

  it("drops a name-duplicate when the user chooses Skip", () => {
    const onImport = vi.fn();
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={onImport}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Build"));
    // Open the choice dropdown and pick "Skip".
    fireEvent.click(
      screen.getByRole("button", {
        name: 'What to do with the duplicate "Build"',
      }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    const selection = onImport.mock.calls[0]?.[0] as ImportSelection;
    expect([...selection.commandIds]).toEqual([]);
    expect(selection.rename.size).toBe(0);
  });

  it("shows a script-only collision as a warning with no action and imports it", () => {
    const onImport = vi.fn();
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={onImport}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Fresh"));
    // Warning shown, but NO rename/skip choice is offered.
    expect(
      screen.getByText("A command with this script already exists"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText('What to do with the duplicate "Fresh"'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const selection = onImport.mock.calls[0]?.[0] as ImportSelection;
    // Imported as a new copy, no rename.
    expect([...selection.commandIds]).toEqual(["c2"]);
    expect(selection.rename.size).toBe(0);
  });

  it("force-includes a workflow's command (shared selection logic)", () => {
    render(
      <ImportDialog
        parsed={envelope()}
        existingCommands={library}
        onImport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(checkboxForRow("Ship"));
    const build = checkboxForRow("Build");
    expect(build.checked).toBe(true);
    expect(build.disabled).toBe(true);
  });
});
