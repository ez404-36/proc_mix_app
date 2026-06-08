// Smoke test for the Recorder (Process Capture) view.
//
// Verifies the cross-cutting behaviour wired in Step 6:
//   - platform gating (Windows shows controls, others show the notice),
//   - the opt-in consent gate (first Start opens the dialog; accepting it
//     persists consent and starts capture; a later Start skips the dialog),
//   - captured events render with a REDACTED command line.
//
// The Tauri boundary (`processCapture`) and platform probe are mocked; the
// store, consent gate, redaction, and component run unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  startProcessCapture: vi.fn(),
  stopProcessCapture: vi.fn(),
  subscribeCaptureEvents: vi.fn(),
  getPlatform: vi.fn(),
  // Captured handler so the test can push fake capture events.
  eventHandler: null as ((e: unknown) => void) | null,
}));

vi.mock("../../utils/processCapture", () => ({
  startProcessCapture: mocks.startProcessCapture,
  stopProcessCapture: mocks.stopProcessCapture,
  subscribeCaptureEvents: (h: (e: unknown) => void) => {
    mocks.eventHandler = h;
    return () => {
      mocks.eventHandler = null;
    };
  },
  isCaptureUnsupportedError: (err: unknown) => err === "CAPTURE_UNSUPPORTED",
  CAPTURE_UNSUPPORTED: "CAPTURE_UNSUPPORTED",
}));

vi.mock("../../utils/platform", () => ({
  getPlatform: mocks.getPlatform,
}));

// Arco's Message uses ReactDOM.render, which is gone in React 19's jsdom
// env. Stub it (same approach as workflowActions.test) so the success toast
// after a save doesn't throw an unhandled rejection.
vi.mock("@arco-design/web-react", () => ({
  Message: { success: vi.fn(), error: vi.fn() },
}));

// Stub the action layer so the smoke test never crosses into the real
// command/workflow stores or the history DB.
const saveMocks = vi.hoisted(() => ({
  saveCaptureAsCommand: vi.fn(),
  saveCaptureAsWorkflow: vi.fn(),
}));
vi.mock("../../services/recordingActions", () => ({
  saveCaptureAsCommand: saveMocks.saveCaptureAsCommand,
  saveCaptureAsWorkflow: saveMocks.saveCaptureAsWorkflow,
}));

import { Recorder } from "./Recorder";
import { useUIStore } from "../../stores/uiStore";
import { useCaptureStore } from "../../stores/captureStore";

beforeEach(() => {
  mocks.startProcessCapture.mockReset().mockResolvedValue(undefined);
  mocks.stopProcessCapture.mockReset().mockResolvedValue(undefined);
  mocks.getPlatform.mockReset().mockResolvedValue("windows");
  saveMocks.saveCaptureAsCommand.mockReset().mockReturnValue([{ id: "c1" }]);
  saveMocks.saveCaptureAsWorkflow
    .mockReset()
    .mockReturnValue({ id: "w1", name: "Recorded workflow" });
  mocks.eventHandler = null;
  useUIStore.setState({ processCaptureEnabled: false });
  useCaptureStore.setState({
    recording: false,
    rows: [],
    selectedIds: new Set<string>(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Recorder gating", () => {
  it("shows the not-yet-implemented notice off Windows", async () => {
    mocks.getPlatform.mockResolvedValue("linux");
    render(<Recorder />);
    expect(
      await screen.findByText(/not yet implemented on this operating system/i),
    ).toBeTruthy();
    // The "Windows only" badge is shown and the controls are hidden.
    expect(screen.getByText("Windows only")).toBeTruthy();
    expect(screen.queryByText("Start recording")).toBeNull();
  });

  it("shows the Start control on Windows", async () => {
    render(<Recorder />);
    expect(await screen.findByText("Start recording")).toBeTruthy();
  });

  it("shows the Start control in Basic mode (recorder is not PRO-gated)", async () => {
    render(<Recorder />);
    // The recorder is available in every tier, so Basic must still show the
    // capture controls (platform support permitting) — no upgrade notice.
    expect(await screen.findByText("Start recording")).toBeTruthy();
  });
});

describe("Recorder consent gate", () => {
  it("opens the consent dialog on first Start and does not capture until accepted", async () => {
    render(<Recorder />);
    const start = await screen.findByText("Start recording");

    await act(async () => {
      start.click();
    });

    // Dialog is shown; capture has NOT started yet.
    expect(await screen.findByText("Enable Process Capture?")).toBeTruthy();
    expect(mocks.startProcessCapture).not.toHaveBeenCalled();
    expect(useUIStore.getState().processCaptureEnabled).toBe(false);

    // Accept consent.
    const accept = screen.getByText("Enable recording");
    await act(async () => {
      accept.click();
    });

    await waitFor(() =>
      expect(mocks.startProcessCapture).toHaveBeenCalledOnce(),
    );
    expect(useUIStore.getState().processCaptureEnabled).toBe(true);
    expect(useCaptureStore.getState().recording).toBe(true);
  });

  it("skips the dialog once consent is already granted", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    render(<Recorder />);
    const start = await screen.findByText("Start recording");

    await act(async () => {
      start.click();
    });

    await waitFor(() =>
      expect(mocks.startProcessCapture).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByText("Enable Process Capture?")).toBeNull();
  });
});

describe("Recorder event rendering", () => {
  it("renders captured rows with a redacted command line", async () => {
    render(<Recorder />);
    await screen.findByText("Start recording");

    await act(async () => {
      mocks.eventHandler?.({
        pid: 10,
        ppid: 1,
        image: "C:/db/mysql.exe",
        commandLine: "mysql --password=hunter2",
        timestamp: "0",
      });
    });

    expect(await screen.findByText("mysql --password=***")).toBeTruthy();
    expect(screen.queryByText(/hunter2/)).toBeNull();
  });
});

describe("Recorder save flow", () => {
  async function captureOneRow(): Promise<void> {
    render(<Recorder />);
    await screen.findByText("Start recording");
    await act(async () => {
      mocks.eventHandler?.({
        pid: 10,
        ppid: 1,
        image: "C:/db/git.exe",
        commandLine: "git status",
        timestamp: "0",
      });
    });
  }

  it("saves the selected rows as commands", async () => {
    await captureOneRow();
    // Tick the row.
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      checkbox.click();
    });

    const saveBtn = await screen.findByText("Save as command");
    await act(async () => {
      saveBtn.click();
    });

    expect(saveMocks.saveCaptureAsCommand).toHaveBeenCalledOnce();
    const passedRows = saveMocks.saveCaptureAsCommand.mock.calls[0]![0] as {
      commandLine: string;
    }[];
    expect(passedRows).toHaveLength(1);
    expect(passedRows[0]!.commandLine).toBe("git status");
  });

  it("disables Save as workflow until at least two rows are selected", async () => {
    await captureOneRow();
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      checkbox.click();
    });
    const wfBtn = (await screen.findByText(
      "Save as workflow",
    )) as HTMLButtonElement;
    expect(wfBtn.disabled).toBe(true);
  });
});
