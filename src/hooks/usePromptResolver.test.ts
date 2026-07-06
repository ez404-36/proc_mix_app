import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptResolver, usePromptAutoFocus } from "./usePromptResolver";
import { createPromptRegistry } from "../utils/createPromptRegistry";

type Args = readonly [alias: string];

function makeRegistry() {
  return createPromptRegistry<Args, string>();
}

describe("usePromptResolver", () => {
  it("opens the prompt and resolves with the submitted result", async () => {
    const registry = makeRegistry();
    const onOpen = vi.fn();
    const onClose = vi.fn();

    const { result } = renderHook(() =>
      usePromptResolver<Args, string>({
        register: registry.register,
        onOpen,
        onClose,
      }),
    );

    let pending: Promise<string | null> | undefined;
    act(() => {
      pending = registry.prompt("host-a");
    });
    expect(onOpen).toHaveBeenCalledWith("host-a");

    act(() => {
      result.current.close("answer");
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe("answer");
  });

  it("resolves null when the prompt is cancelled", async () => {
    const registry = makeRegistry();
    const { result } = renderHook(() =>
      usePromptResolver<Args, string>({
        register: registry.register,
        onOpen: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    let pending: Promise<string | null> | undefined;
    act(() => {
      pending = registry.prompt("host-a");
    });
    act(() => {
      result.current.close(null);
    });

    await expect(pending).resolves.toBeNull();
  });

  it("is a no-op when close is called with nothing open", () => {
    const registry = makeRegistry();
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      usePromptResolver<Args, string>({
        register: registry.register,
        onOpen: vi.fn(),
        onClose,
      }),
    );

    // No prompt in flight — close still runs onClose but resolves nothing.
    expect(() => {
      act(() => {
        result.current.close("ignored");
      });
    }).not.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("force-cancels a stranded prior resolver when a new prompt opens", async () => {
    const registry = makeRegistry();
    renderHook(() =>
      usePromptResolver<Args, string>({
        register: registry.register,
        onOpen: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    let first: Promise<string | null> | undefined;
    let second: Promise<string | null> | undefined;
    act(() => {
      first = registry.prompt("host-a");
    });
    // A second prompt without closing the first must cancel it (resolve null).
    act(() => {
      second = registry.prompt("host-b");
    });

    await expect(first).resolves.toBeNull();
    expect(second).toBeInstanceOf(Promise);
  });

  it("resolves an outstanding prompt to null on unmount", async () => {
    const registry = makeRegistry();
    const { unmount } = renderHook(() =>
      usePromptResolver<Args, string>({
        register: registry.register,
        onOpen: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    let pending: Promise<string | null> | undefined;
    act(() => {
      pending = registry.prompt("host-a");
    });

    act(() => {
      unmount();
    });

    await expect(pending).resolves.toBeNull();
    // Handler is unregistered — further prompts resolve to null immediately.
    await expect(registry.prompt("host-b")).resolves.toBeNull();
  });

  it("uses the latest onOpen/onClose without re-registering", async () => {
    const registry = makeRegistry();
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();

    const { result, rerender } = renderHook(
      ({ onClose }: { onClose: () => void }) =>
        usePromptResolver<Args, string>({
          register: registry.register,
          onOpen: vi.fn(),
          onClose,
        }),
      { initialProps: { onClose: onCloseA } },
    );

    rerender({ onClose: onCloseB });

    let pending: Promise<string | null> | undefined;
    act(() => {
      pending = registry.prompt("host-a");
    });
    act(() => {
      result.current.close("x");
    });

    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe("x");
  });
});

describe("usePromptAutoFocus", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback): number => {
        cb(0);
        return 42;
      });
    cancelSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("focuses the input when the modal becomes visible", () => {
    const input = document.createElement("input");
    const focus = vi.spyOn(input, "focus");
    const select = vi.spyOn(input, "select");

    renderHook(() => {
      const ref = useRef<HTMLInputElement | null>(input);
      usePromptAutoFocus(true, ref);
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("also selects the input when select is true", () => {
    const input = document.createElement("input");
    const focus = vi.spyOn(input, "focus");
    const select = vi.spyOn(input, "select");

    renderHook(() => {
      const ref = useRef<HTMLInputElement | null>(input);
      usePromptAutoFocus(true, ref, true);
    });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the modal is closed", () => {
    renderHook(() => {
      const ref = useRef<HTMLInputElement | null>(null);
      usePromptAutoFocus(false, ref);
    });

    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("tolerates a null ref target without throwing", () => {
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLInputElement | null>(null);
        usePromptAutoFocus(true, ref, true);
      });
    }).not.toThrow();
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending frame on cleanup", () => {
    const input = document.createElement("input");
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        const ref = useRef<HTMLInputElement | null>(input);
        usePromptAutoFocus(open, ref);
      },
      { initialProps: { open: true } },
    );

    rerender({ open: false });

    expect(cancelSpy).toHaveBeenCalledWith(42);
  });
});
