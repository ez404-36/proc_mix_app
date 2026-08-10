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
  setTitle: vi.fn(),
  setIcon: vi.fn(),
  cancelExecution: vi.fn(),
  listMiniAppsFromDb: vi.fn(),
  useExecutionBridge: vi.fn(),
}));

vi.mock("../../services/miniappWindow", () => ({
  getMiniAppWindowId: mocks.getMiniAppWindowId,
}));

// Spy on `useExecutionBridge` itself (rather than mocking its internals) so
// we can assert THIS window passes its resolved mini-app id through — the
// gate that keeps a widget run's output isolated to its own window (see
// `useExecutionBridge`'s doc comment). Delegates to the real implementation
// so the rest of the mount-time behavior this file already covers (event
// subscription via the mocked `subscribeExecutionEvents` below) is
// unaffected.
vi.mock("../../hooks/useExecutionBridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../hooks/useExecutionBridge")>();
  return {
    useExecutionBridge: (id?: string | null) => {
      mocks.useExecutionBridge(id);
      return actual.useExecutionBridge(id);
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: mocks.close,
    onCloseRequested: mocks.onCloseRequested,
    setTitle: mocks.setTitle,
    setIcon: mocks.setIcon,
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

/**
 * Stage a single mini-app as the hydration result, so `miniappStore` flips
 * `hydrated` with this record present — the exact precondition the
 * window-branding effect waits on.
 */
function stageMiniApp(overrides: {
  id?: string;
  name?: string;
  nameKey?: string;
  icon?: string;
}): void {
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
      ...overrides,
    },
  ]);
}

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
  mocks.setTitle.mockReset().mockResolvedValue(undefined);
  mocks.setIcon.mockReset().mockResolvedValue(undefined);
  mocks.cancelExecution.mockReset().mockResolvedValue(undefined);
  mocks.listMiniAppsFromDb.mockReset().mockResolvedValue([]);
  mocks.useExecutionBridge.mockReset();
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

  it("passes the resolved mini-app id into useExecutionBridge, gating this window's execution routing", async () => {
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

    // First render: id not yet resolved (null). Final render: the resolved
    // mini-app id.
    await waitFor(() => {
      expect(mocks.useExecutionBridge).toHaveBeenLastCalledWith("ma-1");
    });
  });
});

describe("MiniAppWindowApp — OS window branding", () => {
  // A 1×1 transparent PNG — the one icon shape `windowIcon.ts` can convert
  // without a canvas, so it is the only one that yields bytes under jsdom.
  const PNG_DATA_URI =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("sets the window title to the mini-app's name once the store hydrates", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({ name: "VPN Panel" });

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => {
      expect(mocks.setTitle).toHaveBeenCalledWith("VPN Panel");
    });
  });

  it("resolves a seed mini-app's nameKey through i18n for the title", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({
      name: "ignored-literal",
      nameKey: "miniapps.seeds.systemInfo.name",
    });

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    // The literal `name` must lose to the translated key (mirrors how the
    // runner header renders it via `getMiniAppName`).
    await waitFor(() => {
      expect(mocks.setTitle).toHaveBeenCalledWith("System Info");
    });
    expect(mocks.setTitle).not.toHaveBeenCalledWith("ignored-literal");
  });

  it("does not touch the window icon for a mini-app without one", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({});

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalled());
    // No icon configured → the bundled ProcMix icon must stay in place.
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });

  it("pushes PNG bytes to setIcon for a mini-app with a PNG icon", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({ icon: PNG_DATA_URI });

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => {
      expect(mocks.setIcon).toHaveBeenCalledTimes(1);
    });
    const [bytes] = mocks.setIcon.mock.calls[0] as [Uint8Array];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("skips setIcon when the icon cannot be rasterised (emoji under jsdom)", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({ icon: "🔌" });

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalled());
    // jsdom has no 2D canvas, so the helper returns null and the effect must
    // simply not call `setIcon` — the same path macOS/Wayland exercise.
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });

  it("survives a rejected setIcon — the runner still renders", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({ name: "VPN Panel", icon: PNG_DATA_URI });
    // macOS has no per-window icons; the command rejects there.
    mocks.setIcon.mockRejectedValue(new Error("unsupported on this platform"));

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => expect(mocks.setIcon).toHaveBeenCalled());
    expect(screen.getByText("VPN Panel")).toBeTruthy();
  });

  it("survives a rejected setTitle — the runner still renders", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-1");
    stageMiniApp({ name: "VPN Panel" });
    mocks.setTitle.mockRejectedValue(new Error("denied"));

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalled());
    expect(screen.getByText("VPN Panel")).toBeTruthy();
  });

  it("does not brand the window when the id resolves but the mini-app is absent", async () => {
    mocks.getMiniAppWindowId.mockResolvedValue("ma-missing");
    stageMiniApp({ id: "ma-1" });

    await act(async () => {
      render(<MiniAppWindowApp />);
    });

    await waitFor(() =>
      expect(mocks.useExecutionBridge).toHaveBeenLastCalledWith("ma-missing"),
    );
    expect(mocks.setTitle).not.toHaveBeenCalled();
    expect(mocks.setIcon).not.toHaveBeenCalled();
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
