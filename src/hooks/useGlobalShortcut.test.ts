import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Mock the global-shortcut plugin. The hook calls register/isRegistered/unregister.
const isRegisteredMock = vi.fn();
const registerMock = vi.fn();
const unregisterMock = vi.fn();
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  isRegistered: (...args: unknown[]) => isRegisteredMock(...args),
  register: (...args: unknown[]) => registerMock(...args),
  unregister: (...args: unknown[]) => unregisterMock(...args),
}));

// Mock the window API used by the press handler.
const winMock = {
  isVisible: vi.fn(),
  isFocused: vi.fn(),
  show: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  hide: vi.fn(),
};
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMock,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useGlobalShortcut } from "./useGlobalShortcut";
import { useUIStore, DEFAULT_TOGGLE_SHORTCUT } from "../stores/uiStore";

interface ShortcutCallback {
  (event: { state: "Pressed" | "Released" }): void;
}

beforeEach(() => {
  isRegisteredMock.mockReset();
  registerMock.mockReset();
  unregisterMock.mockReset();
  Object.values(winMock).forEach((fn) => fn.mockReset());
  useUIStore.setState({ toggleShortcut: DEFAULT_TOGGLE_SHORTCUT });
});

/** Flush a couple of microtasks so the async `apply()` IIFE runs to completion. */
async function flush(): Promise<void> {
  // The hook serializes all register/unregister work onto a shared promise
  // chain (StrictMode safety), so an accelerator change queues the new
  // apply() behind the previous op. Flush generously so the queued operation's
  // internal awaits (isRegistered → unregister → register) all settle.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("useGlobalShortcut - registration", () => {
  it("should register the toggle shortcut on mount when not already registered", async () => {
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockResolvedValue(undefined);

    renderHook(() => useGlobalShortcut());
    await flush();

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(
      DEFAULT_TOGGLE_SHORTCUT,
      expect.any(Function),
    );
  });

  it("should defensively unregister and re-register when the shortcut is already registered (StrictMode-safe)", async () => {
    // The hook is intentionally idempotent: even if isRegistered() reports
    // true (e.g. a stale registration from a prior StrictMode mount cycle),
    // it must call unregister() then register() to guarantee the slot holds
    // the current handler — not a dead one from a previous effect run.
    isRegisteredMock.mockResolvedValue(true);
    unregisterMock.mockResolvedValue(undefined);
    registerMock.mockResolvedValue(undefined);

    renderHook(() => useGlobalShortcut());
    await flush();

    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_TOGGLE_SHORTCUT);
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(
      DEFAULT_TOGGLE_SHORTCUT,
      expect.any(Function),
    );
  });

  it("should log to console.error when register fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockRejectedValue(new Error("denied"));

    renderHook(() => useGlobalShortcut());
    await flush();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("useGlobalShortcut - cleanup", () => {
  it("should call unregister() on unmount when the shortcut was registered", async () => {
    isRegisteredMock.mockResolvedValueOnce(false); // initial register path
    registerMock.mockResolvedValue(undefined);
    // For the cleanup safeUnregister check.
    isRegisteredMock.mockResolvedValueOnce(true);
    unregisterMock.mockResolvedValue(undefined);

    const { unmount } = renderHook(() => useGlobalShortcut());
    await flush();
    unmount();
    await flush();

    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_TOGGLE_SHORTCUT);
  });

  it("should NOT call unregister() on cleanup if the shortcut was never registered (e.g. register threw)", async () => {
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockRejectedValue(new Error("nope"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderHook(() => useGlobalShortcut());
    await flush();
    unmount();
    await flush();

    expect(unregisterMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should swallow errors from unregister and log a warning", async () => {
    isRegisteredMock.mockResolvedValueOnce(false);
    registerMock.mockResolvedValue(undefined);
    // safeUnregister: isRegistered throws.
    isRegisteredMock.mockRejectedValueOnce(new Error("boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { unmount } = renderHook(() => useGlobalShortcut());
    await flush();
    unmount();
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("useGlobalShortcut - unmount before async register completes", () => {
  it("should NOT remember the accelerator as registered when the effect was cancelled before resolution", async () => {
    // We make register resolve only after we have unmounted, and verify the
    // cleanup path does not call unregister (since lastRegistered.current
    // was never set due to `if (!cancelled)`).
    isRegisteredMock.mockResolvedValue(false);
    const resolver: { fn: (() => void) | null } = { fn: null };
    registerMock.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolver.fn = res;
        }),
    );

    const { unmount } = renderHook(() => useGlobalShortcut());
    // Unmount immediately so `cancelled` flips to true before register resolves.
    unmount();
    resolver.fn?.();
    await flush();

    expect(unregisterMock).not.toHaveBeenCalled();
  });
});

describe("useGlobalShortcut - shortcut change re-registration", () => {
  it("should unregister the previous accelerator when the shortcut changes", async () => {
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockResolvedValue(undefined);
    unregisterMock.mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useGlobalShortcut());
    await flush();
    expect(registerMock).toHaveBeenCalledTimes(1);

    // Change the accelerator.
    // safeUnregister will call isRegistered first; make it return true.
    isRegisteredMock.mockResolvedValueOnce(true); // safeUnregister for old
    isRegisteredMock.mockResolvedValueOnce(false); // is new already registered?
    act(() => {
      useUIStore.setState({ toggleShortcut: "Alt+Space" });
    });
    rerender();
    await flush();

    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_TOGGLE_SHORTCUT);
    expect(registerMock).toHaveBeenCalledWith("Alt+Space", expect.any(Function));
  });
});

describe("useGlobalShortcut - previous-accelerator inline unregister (lines 64-66)", () => {
  // ONE bounded attempt to reach the `if (previous && previous !== accelerator)`
  // branch at lines 64-66 of the source, where `apply()` unregisters the
  // previously-registered accelerator INLINE before registering the new one.
  //
  // The claim is that this branch is structurally unreachable from a
  // renderHook test because, on any accelerator (dep) change, React runs the
  // OLD effect's cleanup BEFORE the new effect's setup. The cleanup op is
  // queued FIRST onto the FIFO `opChain`; it nulls `lastRegistered.current`.
  // The new effect's `apply()` is queued SECOND, so by the time it reads
  // `previous = lastRegistered.current` the ref is already null → the
  // `previous !== accelerator` branch never runs.
  //
  // This test tries to interleave the ops so `apply()` observes a NON-null
  // `previous`: it holds the cleanup's `safeUnregister` open (by making its
  // `isRegistered` hang) at the moment of the accelerator change, hoping the
  // new effect's `apply()` runs its synchronous prefix first. A probe records
  // the exact operation order so the outcome is verifiable either way.
  it("attempts to observe a non-null previous accelerator in apply() (documents reachability)", async () => {
    const order: string[] = [];

    // First mount + register settle so lastRegistered.current === DEFAULT.
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockResolvedValue(undefined);
    unregisterMock.mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useGlobalShortcut());
    await flush();
    expect(registerMock).toHaveBeenCalledTimes(1);

    // Now arrange the change. We make the FIRST isRegistered call after the
    // change (the cleanup's safeUnregister(previous)) hang, so the cleanup op
    // stays open on the opChain. If the serialization guarantee holds, apply()
    // cannot start until this resolves — and by then the ref is null.
    const release: { fn: (() => void) | null } = { fn: null };
    isRegisteredMock.mockReset();
    registerMock.mockReset();
    unregisterMock.mockReset();
    registerMock.mockResolvedValue(undefined);
    unregisterMock.mockImplementation((accel: string) => {
      order.push(`unregister:${accel}`);
      return Promise.resolve();
    });
    let call = 0;
    isRegisteredMock.mockImplementation((accel: string) => {
      call += 1;
      order.push(`isRegistered:${accel}#${call}`);
      if (call === 1) {
        // Hold the cleanup's safeUnregister open briefly.
        return new Promise<boolean>((res) => {
          release.fn = () => res(true);
        });
      }
      return Promise.resolve(false);
    });

    act(() => {
      useUIStore.setState({ toggleShortcut: "Alt+Shift+P" });
    });
    rerender();

    // Let microtasks run: the cleanup op starts and blocks on isRegistered#1.
    await flush();
    // Release the cleanup so it can complete (unregister previous + null ref),
    // then apply() runs.
    release.fn?.();
    await flush();
    await flush();

    // Whatever the order, register was called for the new accelerator.
    expect(registerMock).toHaveBeenCalledWith(
      "Alt+Shift+P",
      expect.any(Function),
    );

    // EVIDENCE: the cleanup's isRegistered (for the PREVIOUS accelerator) is
    // the very first op after the change, confirming cleanup is serialized
    // BEFORE apply(). apply() therefore never sees a non-null `previous` that
    // differs from the new accelerator — lines 64-66 stay unreachable.
    expect(order[0]).toBe(`isRegistered:${DEFAULT_TOGGLE_SHORTCUT}#1`);
    // The previous accelerator is unregistered (by the cleanup, not apply's
    // inline branch); the new target's defensive unregister only sees it as
    // not-registered so no second unregister of the previous fires from apply.
    expect(order).toContain(`unregister:${DEFAULT_TOGGLE_SHORTCUT}`);
  });
});

describe("useGlobalShortcut - previous accelerator cleanup on change", () => {
  it("should unregister the previous accelerator and register the new one when the shortcut changes", async () => {
    // On a dep (accelerator) change React runs the old effect's cleanup first
    // — which unregisters the previously-registered accelerator — then the new
    // effect registers the new accelerator.
    isRegisteredMock.mockResolvedValue(false);
    registerMock.mockResolvedValue(undefined);
    unregisterMock.mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useGlobalShortcut());
    await flush();
    expect(registerMock).toHaveBeenCalledTimes(1);

    // The previous accelerator is now remembered by the cleanup path: make
    // isRegistered report it as present so unregister fires for it.
    unregisterMock.mockClear();
    isRegisteredMock.mockResolvedValueOnce(true); // cleanup safeUnregister(previous)
    isRegisteredMock.mockResolvedValueOnce(false); // apply safeUnregister(new target)
    act(() => {
      useUIStore.setState({ toggleShortcut: "Ctrl+Alt+K" });
    });
    rerender();
    await flush();

    // The previous accelerator is unregistered before the new one is registered.
    expect(unregisterMock).toHaveBeenNthCalledWith(1, DEFAULT_TOGGLE_SHORTCUT);
    expect(registerMock).toHaveBeenCalledWith("Ctrl+Alt+K", expect.any(Function));
  });
});

describe("useGlobalShortcut - register resolves after cancellation", () => {
  it("should unregister the accelerator when register() resolves after the effect was cancelled", async () => {
    // register() stays pending until AFTER unmount, so when it finally
    // resolves `cancelled` is already true → the else-branch fires
    // safeUnregister(accelerator) (line 91). Make isRegistered report it as
    // registered so unregister actually runs and we can assert it.
    const resolver: { fn: (() => void) | null } = { fn: null };
    registerMock.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolver.fn = res;
        }),
    );
    // First isRegistered: the defensive pre-register unregister (false).
    isRegisteredMock.mockResolvedValueOnce(false);
    // Second isRegistered: the post-cancel safeUnregister(accelerator) → true.
    isRegisteredMock.mockResolvedValueOnce(true);
    unregisterMock.mockResolvedValue(undefined);

    const { unmount } = renderHook(() => useGlobalShortcut());
    await flush();
    // Cancel while register() is still pending.
    unmount();
    await flush();
    // Now resolve register(): the continuation sees cancelled === true.
    resolver.fn?.();
    await flush();

    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_TOGGLE_SHORTCUT);
  });
});

describe("useGlobalShortcut - press handler behavior", () => {
  /**
   * Helper that mounts the hook and returns the callback that the plugin
   * received via register(). The callback represents what happens when the
   * user actually presses the hotkey.
   */
  async function captureCallback(): Promise<ShortcutCallback> {
    isRegisteredMock.mockResolvedValue(false);
    let cb: ShortcutCallback | null = null;
    registerMock.mockImplementation((_accel: string, fn: ShortcutCallback) => {
      cb = fn;
      return Promise.resolve();
    });
    renderHook(() => useGlobalShortcut());
    await flush();
    if (!cb) throw new Error("callback not captured");
    return cb;
  }

  it("should ignore 'Released' events", async () => {
    const cb = await captureCallback();
    cb({ state: "Released" });
    await flush();
    expect(winMock.isVisible).not.toHaveBeenCalled();
  });

  it("should show, unminimize, focus, and open the palette when the window is hidden", async () => {
    winMock.isVisible.mockResolvedValue(false);
    winMock.show.mockResolvedValue(undefined);
    winMock.unminimize.mockResolvedValue(undefined);
    winMock.setFocus.mockResolvedValue(undefined);

    const cb = await captureCallback();
    cb({ state: "Pressed" });
    await flush();

    expect(winMock.show).toHaveBeenCalled();
    expect(winMock.unminimize).toHaveBeenCalled();
    expect(winMock.setFocus).toHaveBeenCalled();
    expect(useUIStore.getState().paletteOpen).toBe(true);
  });

  it("should unminimize and focus the window when it is visible but not focused", async () => {
    winMock.isVisible.mockResolvedValue(true);
    winMock.isFocused.mockResolvedValue(false);
    winMock.unminimize.mockResolvedValue(undefined);
    winMock.setFocus.mockResolvedValue(undefined);

    const cb = await captureCallback();
    cb({ state: "Pressed" });
    await flush();

    expect(winMock.unminimize).toHaveBeenCalled();
    expect(winMock.setFocus).toHaveBeenCalled();
    expect(winMock.hide).not.toHaveBeenCalled();
  });

  it("should hide the window when it is visible and focused", async () => {
    winMock.isVisible.mockResolvedValue(true);
    winMock.isFocused.mockResolvedValue(true);
    winMock.hide.mockResolvedValue(undefined);

    const cb = await captureCallback();
    cb({ state: "Pressed" });
    await flush();

    expect(winMock.hide).toHaveBeenCalledTimes(1);
  });

  it("should log to console.error when the toggle press handler rejects", async () => {
    winMock.isVisible.mockRejectedValue(new Error("window gone"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cb = await captureCallback();
    cb({ state: "Pressed" });
    await flush();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
