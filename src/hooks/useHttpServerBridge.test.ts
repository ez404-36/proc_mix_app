import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { RequestLogEntry } from "../types/httpServer";

type LogHandler = (entry: RequestLogEntry) => void;

const subscribeRequestLogMock = vi.fn();
vi.mock("../services/httpServerService", () => ({
  subscribeRequestLog: (...args: unknown[]) =>
    subscribeRequestLogMock(...(args as [LogHandler])),
}));

const loadMock = vi.fn();
const syncLanguageMock = vi.fn();
const appendLogMock = vi.fn();
vi.mock("../stores/httpServerStore", () => ({
  useHttpServerStore: {
    getState: () => ({
      load: loadMock,
      syncLanguage: syncLanguageMock,
      appendLog: appendLogMock,
    }),
  },
}));

import { useHttpServerBridge } from "./useHttpServerBridge";

const sampleEntry: RequestLogEntry = {
  ts: "2026-07-06T00:00:00Z",
  method: "GET",
  path: "/api/command/{ref}/run",
  status: 200,
  remoteAddr: "127.0.0.1:5555",
};

beforeEach(() => {
  subscribeRequestLogMock.mockReset();
  loadMock.mockReset().mockResolvedValue(undefined);
  syncLanguageMock.mockReset().mockResolvedValue(undefined);
  appendLogMock.mockReset();
});

/** Mount the hook, capturing the request-log handler and the unsubscribe. */
function mountBridge(): { handler: LogHandler; unmount: () => void } {
  const captured: { handler: LogHandler | null } = { handler: null };
  const unsubscribe = vi.fn();
  subscribeRequestLogMock.mockImplementation((h: LogHandler) => {
    captured.handler = h;
    return unsubscribe;
  });

  const { unmount } = renderHook(() => useHttpServerBridge());
  if (!captured.handler) throw new Error("handler not captured");
  return { handler: captured.handler, unmount };
}

describe("useHttpServerBridge - initial snapshot", () => {
  it("should call load() then syncLanguage() once on mount", async () => {
    // Arrange
    subscribeRequestLogMock.mockReturnValue(() => {});

    // Act
    renderHook(() => useHttpServerBridge());

    // Assert: syncLanguage runs only after load resolves.
    await waitFor(() => {
      expect(syncLanguageMock).toHaveBeenCalledTimes(1);
    });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock.mock.invocationCallOrder[0]).toBeLessThan(
      syncLanguageMock.mock.invocationCallOrder[0],
    );
  });
});

describe("useHttpServerBridge - request log subscription", () => {
  it("should subscribe to the request log on mount", () => {
    // Arrange + Act
    mountBridge();

    // Assert
    expect(subscribeRequestLogMock).toHaveBeenCalledTimes(1);
  });

  it("should append each received entry to the store's live log", () => {
    // Arrange
    const { handler } = mountBridge();

    // Act
    handler(sampleEntry);

    // Assert
    expect(appendLogMock).toHaveBeenCalledTimes(1);
    expect(appendLogMock).toHaveBeenCalledWith(sampleEntry);
  });
});

describe("useHttpServerBridge - cleanup", () => {
  it("should call the returned unsubscribe on unmount", () => {
    // Arrange
    const unsubscribe = vi.fn();
    subscribeRequestLogMock.mockReturnValue(unsubscribe);

    // Act
    const { unmount } = renderHook(() => useHttpServerBridge());
    unmount();

    // Assert
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
