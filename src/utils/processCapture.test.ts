import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state shared between the module mock and the tests.
const mocks = vi.hoisted(() => {
  return {
    invoke: vi.fn(),
    listen: vi.fn(),
    // The handler the module registers with `listen`, captured so tests can
    // drive fake events.
    registeredHandler: null as
      | ((event: { payload: unknown }) => void)
      | null,
    unlisten: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import type { CaptureEvent } from "../types/capture";

const sampleEvent: CaptureEvent = {
  pid: 100,
  ppid: 1,
  image: "C:/tools/git.exe",
  commandLine: "git status",
  timestamp: "0",
};

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.unlisten.mockReset();
  mocks.registeredHandler = null;
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(
    (_name: string, handler: (event: { payload: unknown }) => void) => {
      mocks.registeredHandler = handler;
      return Promise.resolve(mocks.unlisten);
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isCaptureUnsupportedError", () => {
  it("matches the exact sentinel only", async () => {
    const { isCaptureUnsupportedError, CAPTURE_UNSUPPORTED } = await import(
      "./processCapture"
    );
    expect(isCaptureUnsupportedError(CAPTURE_UNSUPPORTED)).toBe(true);
    expect(isCaptureUnsupportedError("capture_unsupported")).toBe(false);
    expect(isCaptureUnsupportedError(new Error(CAPTURE_UNSUPPORTED))).toBe(
      false,
    );
    expect(isCaptureUnsupportedError(undefined)).toBe(false);
  });
});

describe("IPC wrappers", () => {
  it("startProcessCapture invokes the start command", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { startProcessCapture } = await import("./processCapture");
    await startProcessCapture();
    expect(mocks.invoke).toHaveBeenCalledWith("start_process_capture");
  });

  it("stopProcessCapture invokes the stop command", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { stopProcessCapture } = await import("./processCapture");
    await stopProcessCapture();
    expect(mocks.invoke).toHaveBeenCalledWith("stop_process_capture");
  });

  it("processCaptureStatus returns the boolean from Rust", async () => {
    mocks.invoke.mockResolvedValue(true);
    const { processCaptureStatus } = await import("./processCapture");
    await expect(processCaptureStatus()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("process_capture_status");
  });

  it("propagates the unsupported sentinel from start", async () => {
    mocks.invoke.mockRejectedValue("CAPTURE_UNSUPPORTED");
    const { startProcessCapture, isCaptureUnsupportedError } = await import(
      "./processCapture"
    );
    await startProcessCapture().then(
      () => expect.unreachable("should reject"),
      (err) => expect(isCaptureUnsupportedError(err)).toBe(true),
    );
  });
});

describe("subscribeCaptureEvents", () => {
  it("attaches a single Tauri listener even with multiple subscribers", async () => {
    const { subscribeCaptureEvents } = await import("./processCapture");
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeCaptureEvents(a);
    const unsubB = subscribeCaptureEvents(b);

    // Let the lazy listen() promise settle.
    await Promise.resolve();
    expect(mocks.listen).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });

  it("fans an event out to every registered handler", async () => {
    const { subscribeCaptureEvents } = await import("./processCapture");
    const a = vi.fn();
    const b = vi.fn();
    subscribeCaptureEvents(a);
    subscribeCaptureEvents(b);
    await Promise.resolve();

    mocks.registeredHandler?.({ payload: sampleEvent });

    expect(a).toHaveBeenCalledWith(sampleEvent);
    expect(b).toHaveBeenCalledWith(sampleEvent);
  });

  it("stops delivering to a handler after it unsubscribes", async () => {
    const { subscribeCaptureEvents } = await import("./processCapture");
    const a = vi.fn();
    const unsub = subscribeCaptureEvents(a);
    await Promise.resolve();

    unsub();
    mocks.registeredHandler?.({ payload: sampleEvent });

    expect(a).not.toHaveBeenCalled();
  });

  it("returns the unsubscribe synchronously", async () => {
    const { subscribeCaptureEvents } = await import("./processCapture");
    const unsub = subscribeCaptureEvents(vi.fn());
    expect(typeof unsub).toBe("function");
    unsub();
  });
});
