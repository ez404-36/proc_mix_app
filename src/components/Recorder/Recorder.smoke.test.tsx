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
  listCaptureTargets: vi.fn(),
  getPlatform: vi.fn(),
  // Captured handler so the test can push fake capture events.
  eventHandler: null as ((e: unknown) => void) | null,
}));

vi.mock("../../utils/processCapture", () => ({
  startProcessCapture: mocks.startProcessCapture,
  stopProcessCapture: mocks.stopProcessCapture,
  listCaptureTargets: mocks.listCaptureTargets,
  subscribeCaptureEvents: (h: (e: unknown) => void) => {
    mocks.eventHandler = h;
    return () => {
      mocks.eventHandler = null;
    };
  },
  isCaptureUnsupportedError: (err: unknown) => err === "CAPTURE_UNSUPPORTED",
  isCaptureRequiresPrivilegeError: (err: unknown) =>
    err === "CAPTURE_REQUIRES_PRIVILEGE",
  CAPTURE_UNSUPPORTED: "CAPTURE_UNSUPPORTED",
  CAPTURE_REQUIRES_PRIVILEGE: "CAPTURE_REQUIRES_PRIVILEGE",
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
  mocks.listCaptureTargets.mockReset().mockResolvedValue([]);
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
  it("shows the not-yet-implemented notice on unsupported platforms (macOS)", async () => {
    mocks.getPlatform.mockResolvedValue("macos");
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

  it("shows the Start control on Linux (cn_proc backend)", async () => {
    mocks.getPlatform.mockResolvedValue("linux");
    render(<Recorder />);
    expect(await screen.findByText("Start recording")).toBeTruthy();
    // No unsupported notice on Linux.
    expect(
      screen.queryByText(/not yet implemented on this operating system/i),
    ).toBeNull();
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

  it("shows the CAP_NET_ADMIN hint when the backend reports a privilege error", async () => {
    // Linux supports the feature, but the kernel proc connector bind needs
    // CAP_NET_ADMIN — the backend rejects start with the privilege sentinel.
    useUIStore.setState({ processCaptureEnabled: true });
    mocks.getPlatform.mockResolvedValue("linux");
    mocks.startProcessCapture
      .mockReset()
      .mockRejectedValue("CAPTURE_REQUIRES_PRIVILEGE");
    render(<Recorder />);
    const start = await screen.findByText("Start recording");

    await act(async () => {
      start.click();
    });

    // The tailored privilege hint is shown; the feature is NOT hidden, and
    // the generic startFailed message is not used.
    expect(await screen.findByText(/CAP_NET_ADMIN/)).toBeTruthy();
    expect(useCaptureStore.getState().recording).toBe(false);
    expect(screen.getByText("Start recording")).toBeTruthy();
  });
});

describe("Recorder scope selector", () => {
  it("defaults to capturing all processes", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    render(<Recorder />);
    const start = await screen.findByText("Start recording");
    await act(async () => {
      start.click();
    });
    await waitFor(() =>
      expect(mocks.startProcessCapture).toHaveBeenCalledWith({ mode: "all" }),
    );
  });

  it("loads targets when the scope dropdown opens", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    mocks.listCaptureTargets.mockResolvedValue([{ pid: 4321, name: "draw.io" }]);
    render(<Recorder />);
    await screen.findByText("Start recording");

    // The list is fetched only when the dropdown opens (lazy load), not on
    // mount — avoids a useless `/proc` walk if the user never picks an app.
    expect(mocks.listCaptureTargets).not.toHaveBeenCalled();
    const trigger = screen.getByLabelText("What to record");
    await act(async () => {
      trigger.click();
    });
    await waitFor(() => expect(mocks.listCaptureTargets).toHaveBeenCalled());
    // The option appears once loaded.
    expect(await screen.findByText("draw.io")).toBeTruthy();
  });

  it("scopes capture to the chosen app's subtree", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    mocks.listCaptureTargets.mockResolvedValue([
      { pid: 4321, name: "draw.io" },
    ]);
    render(<Recorder />);
    await screen.findByText("Start recording");

    await act(async () => {
      screen.getByLabelText("What to record").click();
    });
    const option = await screen.findByText("draw.io");
    await act(async () => {
      option.click();
    });

    await act(async () => {
      screen.getByText("Start recording").click();
    });
    await waitFor(() =>
      expect(mocks.startProcessCapture).toHaveBeenCalledWith({
        mode: "subtree",
        roots: [4321],
      }),
    );
  });

  it("shows each chosen app as a removable chip (not a count)", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    mocks.listCaptureTargets.mockResolvedValue([
      { pid: 10, name: "draw.io" },
      { pid: 20, name: "obsidian" },
    ]);
    render(<Recorder />);
    await screen.findByText("Start recording");

    await act(async () => {
      screen.getByLabelText("What to record").click();
    });
    // Pick both options from the popup (matched by role to avoid colliding
    // with the chip text that appears in the trigger after selection).
    await act(async () => {
      (await screen.findByRole("option", { name: /draw\.io/ })).click();
    });
    await act(async () => {
      screen.getByRole("option", { name: /obsidian/ }).click();
    });

    // Both names are shown as chips (the trigger does NOT collapse to "2").
    const removeDrawio = screen.getByLabelText("Remove draw.io");
    expect(removeDrawio).toBeTruthy();
    expect(screen.getByLabelText("Remove obsidian")).toBeTruthy();

    // Removing a chip deselects only that app.
    await act(async () => {
      removeDrawio.click();
    });
    expect(screen.queryByLabelText("Remove draw.io")).toBeNull();
    expect(screen.getByLabelText("Remove obsidian")).toBeTruthy();
  });

  it("scopes capture to MULTIPLE chosen apps (multi-select)", async () => {
    useUIStore.setState({ processCaptureEnabled: true });
    mocks.listCaptureTargets.mockResolvedValue([
      { pid: 10, name: "draw.io" },
      { pid: 20, name: "obsidian" },
    ]);
    render(<Recorder />);
    await screen.findByText("Start recording");

    await act(async () => {
      screen.getByLabelText("What to record").click();
    });
    // Multi-select: the popup stays open after the first pick, so we can pick
    // a second app without reopening it. Match by role so the trigger chip
    // (which echoes the label) doesn't create an ambiguous text match.
    await act(async () => {
      (await screen.findByRole("option", { name: /draw\.io/ })).click();
    });
    await act(async () => {
      screen.getByRole("option", { name: /obsidian/ }).click();
    });

    await act(async () => {
      screen.getByText("Start recording").click();
    });
    await waitFor(() =>
      expect(mocks.startProcessCapture).toHaveBeenCalledWith({
        mode: "subtree",
        roots: [10, 20],
      }),
    );
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
