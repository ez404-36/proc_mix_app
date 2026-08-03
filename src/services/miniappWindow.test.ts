import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

// The module calls `listen()` once at import time (`void ensureSubscribed()`
// at module scope, mirroring `utils/executor.ts`), and `vi.mock` factories
// are hoisted above every other statement in this file — including a plain
// `const`. `vi.hoisted` is required so `listenMock` exists (and already
// resolves) by the time the hoisted factory below runs.
const listenMock = vi.hoisted(() => vi.fn().mockResolvedValue(() => {}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  getMiniAppWindowId,
  listOpenMiniAppWindows,
  openMiniAppWindow,
  subscribeMiniAppWindowEvents,
} from "./miniappWindow";
import type { MiniAppWindowEvent } from "../types";

// `listen("miniapp-window-event", …)` is called EXACTLY ONCE, at module
// import time (`void ensureSubscribed()` at module scope) — capture the
// Tauri-side handler here, once, rather than re-reading `listenMock.mock
// .calls` inside each test: `afterEach`'s `vi.clearAllMocks()` wipes call
// history, and `listen()` never fires again for any later
// `subscribeMiniAppWindowEvents` call (that's the whole point of the
// singleton-listener pattern this module shares with `utils/executor.ts`).
const initialListenCall = listenMock.mock.calls.find(
  (c) => c[0] === "miniapp-window-event",
);
if (!initialListenCall) {
  throw new Error("listen(miniapp-window-event) was not called at import");
}
const tauriHandler = initialListenCall[1] as (e: {
  payload: MiniAppWindowEvent;
}) => void;

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("openMiniAppWindow", () => {
  it("invokes open_miniapp_window with the mini-app id", async () => {
    invokeMock.mockResolvedValue(undefined);

    await openMiniAppWindow("ma-1");

    expect(invokeMock).toHaveBeenCalledWith("open_miniapp_window", {
      id: "ma-1",
    });
  });

  it("propagates a rejection from the IPC call", async () => {
    const error = new Error("failed to open window");
    invokeMock.mockRejectedValue(error);

    await expect(openMiniAppWindow("ma-1")).rejects.toBe(error);
  });
});

describe("getMiniAppWindowId", () => {
  it("invokes get_miniapp_window_id and returns the resolved id", async () => {
    invokeMock.mockResolvedValue("ma-2");

    const id = await getMiniAppWindowId();

    expect(invokeMock).toHaveBeenCalledWith("get_miniapp_window_id", undefined);
    expect(id).toBe("ma-2");
  });

  it("propagates a rejection from the IPC call", async () => {
    const error = new Error("not a mini-app window");
    invokeMock.mockRejectedValue(error);

    await expect(getMiniAppWindowId()).rejects.toBe(error);
  });
});

describe("listOpenMiniAppWindows", () => {
  it("invokes list_open_miniapp_windows and returns the resolved ids", async () => {
    invokeMock.mockResolvedValue(["ma-1", "ma-2"]);

    const ids = await listOpenMiniAppWindows();

    expect(invokeMock).toHaveBeenCalledWith(
      "list_open_miniapp_windows",
      undefined,
    );
    expect(ids).toEqual(["ma-1", "ma-2"]);
  });

  it("propagates a rejection from the IPC call", async () => {
    const error = new Error("ipc down");
    invokeMock.mockRejectedValue(error);

    await expect(listOpenMiniAppWindows()).rejects.toBe(error);
  });
});

describe("subscribeMiniAppWindowEvents", () => {
  it("registering a handler does not call listen() again — the module-level listener is shared", () => {
    const callsBefore = listenMock.mock.calls.length;
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = subscribeMiniAppWindowEvents(handlerA);
    const unsubB = subscribeMiniAppWindowEvents(handlerB);

    expect(listenMock.mock.calls.length).toBe(callsBefore);

    unsubA();
    unsubB();
  });

  it("fans a single Tauri event out to every registered handler", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = subscribeMiniAppWindowEvents(handlerA);
    const unsubB = subscribeMiniAppWindowEvents(handlerB);

    const event: MiniAppWindowEvent = { kind: "opened", id: "ma-1" };
    tauriHandler({ payload: event });

    expect(handlerA).toHaveBeenCalledWith(event);
    expect(handlerB).toHaveBeenCalledWith(event);

    // The module-level handler Set persists across tests (it's the shared
    // fan-out registry `ensureSubscribed()` reads on every real event); leave
    // it exactly as this test found it.
    unsubA();
    unsubB();
  });

  it("unsubscribe removes only that handler from the fan-out", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = subscribeMiniAppWindowEvents(handlerA);
    const unsubB = subscribeMiniAppWindowEvents(handlerB);
    unsubA();

    tauriHandler({ payload: { kind: "closed", id: "ma-1" } });

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);

    unsubB();
  });
});
