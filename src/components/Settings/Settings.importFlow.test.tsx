// Smoke test for the Settings import flow (feature: selectable import + inline
// status plaque). Covers the wiring added to Settings:
//   - clicking Import reads/validates the file (`importData`) then opens the
//     ImportDialog showing the file's objects;
//   - confirming the dialog hands the resolved selection to `applyImport` and
//     renders a green success plaque (no toast);
//   - a parse/validation failure renders a red error plaque and never opens
//     the dialog.
//
// The Tauri boundary (`dataTransfer`) and the store-writing `applyImport` are
// mocked; the ImportDialog, duplicate detection, and Settings wiring run real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  class InvalidImportError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InvalidImportError";
    }
  }
  return {
    importData: vi.fn(),
    exportData: vi.fn(),
    applyImport: vi.fn(),
    InvalidImportError,
  };
});

vi.mock("../../utils/dataTransfer", () => ({
  importData: mocks.importData,
  exportData: mocks.exportData,
  InvalidImportError: mocks.InvalidImportError,
  EXPORT_VERSION: 1,
}));

vi.mock("../../services/dataImport", () => ({
  applyImport: mocks.applyImport,
}));

// Arco's Message uses ReactDOM.render which is gone in React 19's jsdom env;
// the admin section uses it. Stub it so nothing throws.
vi.mock("@arco-design/web-react", () => ({
  Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Admin-password section probes the keychain on mount; keep it inert.
vi.mock("../../utils/adminPassword", () => ({
  hasAdminPassword: vi.fn().mockResolvedValue(false),
  setAdminPassword: vi.fn(),
  clearAdminPassword: vi.fn(),
}));

vi.mock("../../utils/platform", () => ({
  getCachedPlatform: () => "linux",
}));

import { Settings } from "./Settings";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import "../../i18n";

function fileEnvelope() {
  return {
    version: 1 as const,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands: [
      {
        id: "c1",
        name: "Imported cmd",
        script: "echo hi",
        tags: [],
        runAsAdmin: false,
      },
    ],
    workflows: [],
  };
}

beforeEach(() => {
  mocks.importData.mockReset();
  mocks.exportData.mockReset();
  mocks.applyImport.mockReset();
  useCommandStore.setState({ commands: [] });
  useWorkflowStore.setState({ workflows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings import flow", () => {
  it("opens the ImportDialog after a successful file read, then applies the selection and shows a success plaque", async () => {
    mocks.importData.mockResolvedValue(fileEnvelope());
    mocks.applyImport.mockReturnValue({
      commands: 1,
      renamed: 0,
      workflows: 0,
      demotedAdmin: 0,
    });

    render(<Settings />);

    // DataSection lives under the "Security & data" tab, hidden by default.
    await act(async () => {
      screen.getByRole("tab", { name: "Security & data" }).click();
    });

    const importBtn = screen.getByRole("button", { name: /Import…/ });
    await act(async () => {
      importBtn.click();
    });

    // Dialog opened with the file's command listed.
    expect(await screen.findByText("Imported cmd")).toBeTruthy();
    expect(mocks.applyImport).not.toHaveBeenCalled();

    // Select the command and confirm.
    const checkbox = screen
      .getByText("Imported cmd")
      .closest("label")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    const confirm = screen.getByRole("button", { name: "Import" });
    await act(async () => {
      confirm.click();
    });

    expect(mocks.applyImport).toHaveBeenCalledTimes(1);
    const [, selection] = mocks.applyImport.mock.calls[0]!;
    expect([...selection.commandIds]).toEqual(["c1"]);

    // Inline success plaque, not a toast.
    const status = await screen.findByRole("status");
    expect(status.className).toContain("data-status--success");
  });

  it("shows an error plaque and never opens the dialog on an invalid file", async () => {
    mocks.importData.mockRejectedValue(new mocks.InvalidImportError("bad"));

    render(<Settings />);
    await act(async () => {
      screen.getByRole("tab", { name: "Security & data" }).click();
    });
    const importBtn = screen.getByRole("button", { name: /Import…/ });
    await act(async () => {
      importBtn.click();
    });

    const status = await screen.findByRole("status");
    expect(status.className).toContain("data-status--error");
    expect(mocks.applyImport).not.toHaveBeenCalled();
    // The selection dialog never appeared.
    expect(
      screen.queryByRole("button", { name: "Import" }),
    ).toBeNull();
  });

  it("stays silent when the user cancels the native file dialog", async () => {
    mocks.importData.mockResolvedValue(null);

    render(<Settings />);
    await act(async () => {
      screen.getByRole("tab", { name: "Security & data" }).click();
    });
    const importBtn = screen.getByRole("button", { name: /Import…/ });
    await act(async () => {
      importBtn.click();
    });

    await waitFor(() => expect(mocks.importData).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
