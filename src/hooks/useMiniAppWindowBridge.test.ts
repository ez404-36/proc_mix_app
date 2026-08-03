import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MiniAppWindowEvent } from "../types";

// Capture the handler passed to subscribeMiniAppWindowEvents so tests can
// fire events synchronously, mirroring `useExecutionBridge.test.ts`.
const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();
vi.mock("../services/miniappWindow", () => ({
  subscribeMiniAppWindowEvents: (...args: unknown[]) => subscribeMock(...args),
}));

import { useMiniAppWindowBridge } from "./useMiniAppWindowBridge";
import { useMiniAppWindowStore } from "../stores/miniappWindowStore";

type Handler = (e: MiniAppWindowEvent) => void;

beforeEach(() => {
  subscribeMock.mockReset();
  unsubscribeMock.mockReset();
  useMiniAppWindowStore.setState({ runningIds: new Set() });
});

function mountBridge(): { handler: Handler } {
  const captured: { handler: Handler | null } = { handler: null };
  subscribeMock.mockImplementation((h: Handler) => {
    captured.handler = h;
    return unsubscribeMock;
  });
  renderHook(() => useMiniAppWindowBridge());
  if (!captured.handler) throw new Error("handler not captured");
  return { handler: captured.handler };
}

describe("useMiniAppWindowBridge", () => {
  it("subscribes exactly once on mount", () => {
    mountBridge();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("marks a mini-app as running on an 'opened' event", () => {
    const { handler } = mountBridge();
    handler({ kind: "opened", id: "ma-1" });
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(true);
  });

  it("clears a mini-app's running state on a 'closed' event", () => {
    const { handler } = mountBridge();
    handler({ kind: "opened", id: "ma-1" });
    handler({ kind: "closed", id: "ma-1" });
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(false);
  });

  it("tracks multiple mini-apps independently", () => {
    const { handler } = mountBridge();
    handler({ kind: "opened", id: "ma-1" });
    handler({ kind: "opened", id: "ma-2" });
    handler({ kind: "closed", id: "ma-1" });
    const { runningIds } = useMiniAppWindowStore.getState();
    expect(runningIds.has("ma-1")).toBe(false);
    expect(runningIds.has("ma-2")).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    const captured: { handler: Handler | null } = { handler: null };
    subscribeMock.mockImplementation((h: Handler) => {
      captured.handler = h;
      return unsubscribeMock;
    });
    const { unmount } = renderHook(() => useMiniAppWindowBridge());
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
