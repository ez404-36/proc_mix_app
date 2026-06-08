import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useTheme } from "./useTheme";
import { useUIStore } from "../stores/uiStore";

// Helper: minimal MediaQueryList stub controllable per-test.
interface ControllableMQL {
  matches: boolean;
  listener: ((e: MediaQueryListEvent) => void) | null;
  addEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (
    type: string,
    cb: (e: MediaQueryListEvent) => void,
  ) => void;
}

function makeMediaQuery(initialMatches: boolean): ControllableMQL {
  const mq: ControllableMQL = {
    matches: initialMatches,
    listener: null,
    addEventListener: (_type, cb) => {
      mq.listener = cb;
    },
    removeEventListener: (_type, cb) => {
      if (mq.listener === cb) mq.listener = null;
    },
  };
  return mq;
}

let mql: ControllableMQL;
let originalMatchMedia: typeof window.matchMedia | undefined;

beforeEach(() => {
  mql = makeMediaQuery(false);
  // jsdom does not implement matchMedia, so define it directly.
  originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (() => mql as unknown as MediaQueryList) as typeof window.matchMedia,
  });

  // Reset persisted ui store so theme starts at "system".
  useUIStore.setState({ theme: "system" });
  // Clear document side-effects.
  document.documentElement.removeAttribute("data-theme");
  document.body.removeAttribute("arco-theme");
});

afterEach(() => {
  // Restore previous matchMedia (usually undefined in jsdom).
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

describe("useTheme initial resolution", () => {
  it("should resolve to 'light' when system prefers light and theme='system'", () => {
    mql.matches = false;
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("should resolve to 'dark' when system prefers dark and theme='system'", () => {
    mql.matches = true;
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("should resolve to the explicit theme value, ignoring the system preference", () => {
    mql.matches = true;
    useUIStore.setState({ theme: "light" });
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");
  });
});

describe("useTheme document side-effects", () => {
  it("should set documentElement[data-theme] to the resolved value", () => {
    mql.matches = true;
    renderHook(() => useTheme());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("should set body[arco-theme]='dark' when resolved=dark", () => {
    mql.matches = true;
    renderHook(() => useTheme());
    expect(document.body.getAttribute("arco-theme")).toBe("dark");
  });

  it("should remove body[arco-theme] when resolved=light", () => {
    document.body.setAttribute("arco-theme", "dark");
    mql.matches = false;
    renderHook(() => useTheme());
    expect(document.body.hasAttribute("arco-theme")).toBe(false);
  });
});

describe("useTheme system preference change subscription", () => {
  it("should react when the MediaQueryList fires a 'change' event", () => {
    mql.matches = false;
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");

    act(() => {
      mql.matches = true;
      mql.listener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("should react with light when 'change' delivers matches=false", () => {
    mql.matches = true;
    const { result } = renderHook(() => useTheme());
    act(() => {
      mql.matches = false;
      mql.listener?.({ matches: false } as MediaQueryListEvent);
    });
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("should unsubscribe from the MediaQueryList on unmount", () => {
    const { unmount } = renderHook(() => useTheme());
    expect(mql.listener).not.toBeNull();
    unmount();
    expect(mql.listener).toBeNull();
  });
});

describe("useTheme setTheme()", () => {
  it("should propagate setTheme calls to the ui store and re-resolve", () => {
    mql.matches = true; // system prefers dark
    const { result, rerender } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("dark");

    act(() => result.current.setTheme("light"));
    rerender();

    expect(useUIStore.getState().theme).toBe("light");
    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
  });
});

describe("useTheme environment guards", () => {
  it("should default to 'light' when window.matchMedia is unavailable", () => {
    // Replace window.matchMedia with undefined for this test only.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useTheme());
    // resolvedTheme should fall back to light (system default).
    expect(result.current.resolvedTheme).toBe("light");
  });

  // NOTE: the `typeof document === "undefined"` early-return inside useTheme
  // is genuine SSR-safety defensive code. It cannot be exercised under React's
  // test runtime because React Testing Library itself requires a document.
  // The guard remains valuable but is intentionally uncovered.
});
