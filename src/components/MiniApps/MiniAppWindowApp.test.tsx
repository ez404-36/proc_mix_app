// Mount test for the standalone Mini-App window root. The IPC boundaries
// (mini-app id resolution, command/mini-app hydration, execution bridge,
// Tauri window API) are mocked; we assert the mount-time contract: resolve
// the id, hydrate the stores, render the runner, and install the
// onCloseRequested guard — including the "kill active processes?"
// confirmation when the mini-app has running processes at close time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getMiniAppWindowId: vi.fn(),
  close: vi.fn(),
  onCloseRequested: vi.fn(),
  cancelExecution: vi.fn(),
  listMiniAppsFromDb: vi.fn(),
}));

vi.mock("../../services/miniappWindow", () => ({
  getMiniAppWindowId: mocks.getMiniAppWindowId,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: mocks.close,
    onCloseRequested: mocks.onCloseRequested,
  }),
}));

vi.mock("../../utils/executor", () => ({
  cancelExecution: mocks.cancelExecution,
  subscribeExecutionEvents: vi.fn(() => () => {}),
}));

vi.mock("../../utils/miniappRepository", () => ({
  listMiniAppsFromDb: mocks.listMiniAppsFromDb,
  getMiniAppFromDb: vi.fn().mockResolvedValue(null),
  saveMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  deleteMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  runStatusProbe: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../utils/commandRepository", () => ({
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/miniappStatusPoller", () => ({
  useMiniAppStatusPolling: vi.fn(() => ({})),
}));

vi.mock("@arco-design/web-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@arco-design/web-react")>();
  return {
    ...actual,
    Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});

import "../../i18n";
import { useExecutionStore } from "../../stores/executionStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { MiniAppWindowApp } from "./MiniAppWindowApp";

function stageCloseRequestedHandler(): (event: {
  preventDefault: () => void;
}) => void {
  const calls = mocks.onCloseRequested.mock.calls;
  const last = calls[calls.length - 1] as
    | [(event: { preventDefault: () => void }) => void]
    | undefined;
  if (last === undefined) throw new Error("onCloseRequested was never called");
  return last[0];
}

beforeEach(() => {
  mocks.getMiniAppWindowId.mockReset();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.onCloseRequested.mockReset().mockResolvedValue(() => {});
  mocks.cancelExecution.mockReset().mockResolvedValue(undefined);
  mocks.listMiniAppsFromDb.mockReset().mockResolvedValue([]);
  useMiniAppStore.setState({ miniapps: [], favorites: [], hydrated: false });
  useExecutionStore.setState({ executions: {}, recentIds: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MiniAppWindowApp — mount / id resolution", () => {
  it("resolves the mini-app id and renders the runner", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    mocks.listMiniAppsFromDb.mockResolvedValue([
      {
        id: "ma-1",
        name: "VPN Panel",
        widgets: [],
        tags: [],
        favorite: false,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
        runCount: 0,
        panelSize: { w: 320, h: 240 },
      },
    ]);

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => {
      expect(screen.getByText("VPN Panel")).toBeTruthy();
    });
  });

  it("shows an error state when id resolution fails", async () => {
    mocks.getMiniAppWindowId.mockRejectedValue(new Error("bad label"));

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => {
      expect(screen.getByText(/bad label/)).toBeTruthy();
    });
  });
});

describe("MiniAppWindowApp — close guard", () => {
  it("installs an onCloseRequested handler on mount", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => {
      expect(mocks.onCloseRequested).toHaveBeenCalledTimes(1);
    });
  });

  it("lets the close proceed when there are no active processes", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalled());

    const handler = stageCloseRequestedHandler();
    const preventDefault = vi.fn();
    act(() => {
      handler({ preventDefault });
    });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("intercepts the close and shows the confirm dialog when a process is active", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalled());

    act(() => {
      useExecutionStore.getState().startExecution("exec-1", undefined, "Connect");
    });

    const handler = stageCloseRequestedHandler();
    const preventDefault = vi.fn();
    act(() => {
      handler({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("cancels every active execution and closes when the user confirms with the kill toggle on", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalled());

    act(() => {
      useExecutionStore.getState().startExecution("exec-1", undefined, "Connect");
      useExecutionStore.getState().startExecution("exec-2", undefined, "Disconnect");
    });

    const handler = stageCloseRequestedHandler();
    act(() => {
      handler({ preventDefault: vi.fn() });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    });

    expect(mocks.cancelExecution).toHaveBeenCalledWith("exec-1");
    expect(mocks.cancelExecution).toHaveBeenCalledWith("exec-2");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("does not cancel executions when the user turns the kill toggle off", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalled());

    act(() => {
      useExecutionStore.getState().startExecution("exec-1", undefined, "Connect");
    });

    const handler = stageCloseRequestedHandler();
    act(() => {
      handler({ preventDefault: vi.fn() });
    });

    act(() => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Kill all child processes" }),
      );
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    });

    expect(mocks.cancelExecution).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("Cancel dismisses the dialog without closing the window", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");

    await act(async () => {
      render(<MiniAppWindowApp />);
    });
    await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalled());

    act(() => {
      useExecutionStore.getState().startExecution("exec-1", undefined, "Connect");
    });

    const handler = stageCloseRequestedHandler();
    act(() => {
      handler({ preventDefault: vi.fn() });
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
