import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getVersionMock = vi.fn();
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: (...args: unknown[]) => getVersionMock(...args),
}));

import { useAppVersion } from "./useAppVersion";

beforeEach(() => {
  getVersionMock.mockReset();
});

describe("useAppVersion - success path", () => {
  it("should return null before the async lookup resolves", () => {
    // Arrange: a never-settling promise so the effect stays pending.
    getVersionMock.mockReturnValue(new Promise<string>(() => {}));

    // Act
    const { result } = renderHook(() => useAppVersion());

    // Assert: the initial state is null until getVersion resolves.
    expect(result.current).toBeNull();
  });

  it("should set the version state once getVersion resolves", async () => {
    // Arrange
    getVersionMock.mockResolvedValue("1.2.3");

    // Act
    const { result } = renderHook(() => useAppVersion());

    // Assert
    await waitFor(() => {
      expect(result.current).toBe("1.2.3");
    });
  });
});

describe("useAppVersion - failure path", () => {
  it("should keep the version null when getVersion rejects (non-Tauri context)", async () => {
    // Arrange: simulate the Tauri API being unavailable.
    getVersionMock.mockRejectedValue(new Error("no tauri"));

    // Act
    const { result } = renderHook(() => useAppVersion());

    // Assert: the catch branch leaves the version unset without throwing.
    await waitFor(() => {
      expect(getVersionMock).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });
});

describe("useAppVersion - cancellation guard", () => {
  it("should not throw or warn when the hook unmounts before getVersion resolves", async () => {
    // Arrange: a deferred promise we resolve only AFTER unmount, so the
    // `cancelled` guard must prevent the post-unmount setState.
    const deferred: { resolve: (v: string) => void } = { resolve: () => {} };
    getVersionMock.mockReturnValue(
      new Promise<string>((res) => {
        deferred.resolve = res;
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Act
    const { unmount } = renderHook(() => useAppVersion());
    unmount();
    deferred.resolve("9.9.9");
    // Flush the resolved-promise continuation.
    await Promise.resolve();
    await Promise.resolve();

    // Assert: the guarded setState never ran, so React logged no warning.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("should not throw or warn when the hook unmounts before getVersion rejects", async () => {
    // Arrange: a deferred rejecting promise settled after unmount so the
    // catch-branch `cancelled` guard is exercised.
    const deferred: { reject: (e: Error) => void } = { reject: () => {} };
    getVersionMock.mockReturnValue(
      new Promise<string>((_res, rej) => {
        deferred.reject = rej;
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Act
    const { unmount } = renderHook(() => useAppVersion());
    unmount();
    deferred.reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
