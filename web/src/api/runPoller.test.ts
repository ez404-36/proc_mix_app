import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the client so the poller's HTTP calls are fully controlled.
const getRunStatusMock = vi.fn();
vi.mock("./client", async () => {
  const actual =
    await vi.importActual<typeof import("./client")>("./client");
  return {
    ...actual,
    getRunStatus: (id: string) => getRunStatusMock(id),
  };
});

import { startPolling, stopAllPolling } from "./runPoller";
import { ApiError } from "./client";
import { useRunStore } from "../stores/runStore";

function resetRunStore(): void {
  useRunStore.setState({ runs: [] });
}

function trackedStatus(executionId: string): string | undefined {
  return useRunStore
    .getState()
    .runs.find((r) => r.executionId === executionId)?.status;
}

/** Drive `document.visibilityState` and dispatch the change event. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRunStore();
  setVisibility("visible");
});

afterEach(() => {
  stopAllPolling();
  setVisibility("visible");
  vi.useRealTimers();
});

describe("runPoller", () => {
  it("polls until terminal then stops, recording status + output", async () => {
    useRunStore.getState().trackRun({
      executionId: "e1",
      kind: "command",
      name: "cmd",
    });

    getRunStatusMock
      .mockResolvedValueOnce({
        executionId: "e1",
        kind: "command",
        name: "cmd",
        status: "running",
      })
      .mockResolvedValueOnce({
        executionId: "e1",
        kind: "command",
        name: "cmd",
        status: "succeeded",
        exitCode: 0,
        output: [{ stream: "stdout", line: "done" }],
      });

    startPolling("e1");

    // First tick runs immediately (timeout 0).
    await vi.advanceTimersByTimeAsync(0);
    expect(trackedStatus("e1")).toBe("running");

    // Next poll ~1s later reaches the terminal state.
    await vi.advanceTimersByTimeAsync(1000);
    expect(trackedStatus("e1")).toBe("succeeded");

    const run = useRunStore.getState().runs.find((r) => r.executionId === "e1");
    expect(run?.exitCode).toBe(0);
    expect(run?.output).toEqual([{ stream: "stdout", line: "done" }]);

    // No further polling after terminal: advancing time makes no more calls.
    const callsAfterTerminal = getRunStatusMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(getRunStatusMock.mock.calls.length).toBe(callsAfterTerminal);
  });

  it("does not clobber existing output with a later empty running poll", async () => {
    useRunStore.getState().trackRun({
      executionId: "e2",
      kind: "command",
      name: "cmd",
    });
    // Output present, but still running; a subsequent poll omits output.
    getRunStatusMock
      .mockResolvedValueOnce({
        executionId: "e2",
        kind: "command",
        name: "cmd",
        status: "running",
        output: [{ stream: "stdout", line: "partial" }],
      })
      .mockResolvedValueOnce({
        executionId: "e2",
        kind: "command",
        name: "cmd",
        status: "running",
      });

    startPolling("e2");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    const run = useRunStore.getState().runs.find((r) => r.executionId === "e2");
    expect(run?.output).toEqual([{ stream: "stdout", line: "partial" }]);
  });

  it("never polls a synthetic failed id", async () => {
    startPolling("failed-123");
    await vi.advanceTimersByTimeAsync(2000);
    expect(getRunStatusMock).not.toHaveBeenCalled();
  });

  it("gives up after the 404 grace window and marks the run failed", async () => {
    useRunStore.getState().trackRun({
      executionId: "e3",
      kind: "command",
      name: "cmd",
    });
    getRunStatusMock.mockRejectedValue(
      new ApiError(404, "notFound", "notFound"),
    );

    startPolling("e3");
    // Drive well past the 10s grace window.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(trackedStatus("e3")).toBe("failed");
  });

  it("marks a never-terminating run stale after the max poll duration", async () => {
    useRunStore.getState().trackRun({
      executionId: "e4",
      kind: "command",
      name: "cmd",
    });
    // Always running — never reaches a terminal state.
    getRunStatusMock.mockResolvedValue({
      executionId: "e4",
      kind: "command",
      name: "cmd",
      status: "running",
    });

    startPolling("e4");
    await vi.advanceTimersByTimeAsync(0);
    expect(trackedStatus("e4")).toBe("running");

    // Advance past the 10-minute deadline.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(trackedStatus("e4")).toBe("stale");

    // Polling has stopped: no further calls after going stale.
    const calls = getRunStatusMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getRunStatusMock.mock.calls.length).toBe(calls);
  });

  it("suspends fetching while the tab is hidden, resumes on visible", async () => {
    useRunStore.getState().trackRun({
      executionId: "e5",
      kind: "command",
      name: "cmd",
    });
    getRunStatusMock.mockResolvedValue({
      executionId: "e5",
      kind: "command",
      name: "cmd",
      status: "running",
    });

    startPolling("e5");
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeHide = getRunStatusMock.mock.calls.length;
    expect(callsBeforeHide).toBeGreaterThan(0);

    // Hide the tab — subsequent ticks must NOT fetch.
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getRunStatusMock.mock.calls.length).toBe(callsBeforeHide);

    // Reveal the tab — a poll fires immediately on resume.
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(getRunStatusMock.mock.calls.length).toBeGreaterThan(callsBeforeHide);
  });

  it("pagehide cancels all active polls", async () => {
    useRunStore.getState().trackRun({
      executionId: "e6",
      kind: "command",
      name: "cmd",
    });
    getRunStatusMock.mockResolvedValue({
      executionId: "e6",
      kind: "command",
      name: "cmd",
      status: "running",
    });

    startPolling("e6");
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("pagehide"));

    const calls = getRunStatusMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getRunStatusMock.mock.calls.length).toBe(calls);
  });
});
