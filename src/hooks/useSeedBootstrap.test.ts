import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Platform, PlatformOrUnknown } from "../types/platform";

interface CommandLike {
  id: string;
}

// Mutable state the mocked store getState() closures read.
const hydrateCommands = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const initializeSeeds = vi.fn<(platform: Platform) => void>();
let commandsValue: CommandLike[] = [];

const hydrateWorkflows = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const hydrateSchedules = vi
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);

const getPlatformMock = vi.fn<() => Promise<PlatformOrUnknown>>();
const loadAvailableShellsMock = vi.fn<() => Promise<void>>();

vi.mock("../stores/commandStore", () => ({
  useCommandStore: {
    getState: () => ({
      hydrateFromDb: hydrateCommands,
      initializeSeeds,
      commands: commandsValue,
    }),
  },
}));
vi.mock("../stores/workflowStore", () => ({
  useWorkflowStore: {
    getState: () => ({ hydrateFromDb: hydrateWorkflows }),
  },
}));
vi.mock("../stores/scheduleStore", () => ({
  useScheduleStore: {
    getState: () => ({ hydrateFromDb: hydrateSchedules }),
  },
}));
vi.mock("../utils/platform", () => ({
  getPlatform: () => getPlatformMock(),
}));
vi.mock("../utils/shells", () => ({
  loadAvailableShells: () => loadAvailableShellsMock(),
}));

import { useSeedBootstrap } from "./useSeedBootstrap";

beforeEach(() => {
  hydrateCommands.mockReset().mockResolvedValue(undefined);
  initializeSeeds.mockReset();
  hydrateWorkflows.mockReset().mockResolvedValue(undefined);
  hydrateSchedules.mockReset().mockResolvedValue(undefined);
  getPlatformMock.mockReset();
  loadAvailableShellsMock.mockReset().mockResolvedValue(undefined);
  commandsValue = [];
});

describe("useSeedBootstrap - hydration fan-out", () => {
  it("should kick off shell detection and hydrate all three stores on mount", async () => {
    // Arrange: empty command set → seed path (also resolves the platform).
    commandsValue = [];
    getPlatformMock.mockResolvedValue("linux");

    // Act
    renderHook(() => useSeedBootstrap());

    // Assert: fire-and-forget hydrations + shell detection all triggered.
    await waitFor(() => {
      expect(initializeSeeds).toHaveBeenCalled();
    });
    expect(loadAvailableShellsMock).toHaveBeenCalledTimes(1);
    expect(hydrateWorkflows).toHaveBeenCalledTimes(1);
    expect(hydrateSchedules).toHaveBeenCalledTimes(1);
    expect(hydrateCommands).toHaveBeenCalledTimes(1);
  });
});

describe("useSeedBootstrap - existing commands", () => {
  it("should skip seeding when the command store already has commands", async () => {
    // Arrange: a non-empty hydrated set.
    commandsValue = [{ id: "cmd-1" }];

    // Act
    renderHook(() => useSeedBootstrap());
    await waitFor(() => {
      expect(hydrateCommands).toHaveBeenCalled();
    });
    // Let any (unexpected) async continuation run.
    await Promise.resolve();
    await Promise.resolve();

    // Assert: the seed branch was never entered.
    expect(getPlatformMock).not.toHaveBeenCalled();
    expect(initializeSeeds).not.toHaveBeenCalled();
  });
});

describe("useSeedBootstrap - seeding when empty", () => {
  it("should resolve the platform and initialize seeds for a real platform", async () => {
    // Arrange
    commandsValue = [];
    getPlatformMock.mockResolvedValue("macos");

    // Act
    renderHook(() => useSeedBootstrap());

    // Assert: the resolved platform passes through unchanged.
    await waitFor(() => {
      expect(initializeSeeds).toHaveBeenCalledWith("macos");
    });
    expect(getPlatformMock).toHaveBeenCalledTimes(1);
  });

  it("should fall back to 'linux' when the platform resolves to 'unknown'", async () => {
    // Arrange
    commandsValue = [];
    getPlatformMock.mockResolvedValue("unknown");

    // Act
    renderHook(() => useSeedBootstrap());

    // Assert: the "unknown" → "linux" branch.
    await waitFor(() => {
      expect(initializeSeeds).toHaveBeenCalledWith("linux");
    });
  });
});

describe("useSeedBootstrap - cancellation guards", () => {
  it("should NOT initialize seeds when unmounted before command hydration resolves", async () => {
    // Arrange: a deferred command hydration so we can unmount while it is in
    // flight, exercising the `if (cancelled) return` guard after the await.
    const deferred: { resolve: () => void } = { resolve: () => {} };
    hydrateCommands.mockReturnValue(
      new Promise<void>((res) => {
        deferred.resolve = res;
      }),
    );
    getPlatformMock.mockResolvedValue("linux");
    commandsValue = [];

    // Act
    const { unmount } = renderHook(() => useSeedBootstrap());
    unmount();
    deferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Assert: the guard short-circuited before seeding.
    expect(getPlatformMock).not.toHaveBeenCalled();
    expect(initializeSeeds).not.toHaveBeenCalled();
  });

  it("should NOT initialize seeds when unmounted before the platform resolves", async () => {
    // Arrange: hydration resolves immediately (empty set), but getPlatform is
    // deferred so we can unmount before it settles — the second guard.
    const deferred: { resolve: (p: PlatformOrUnknown) => void } = {
      resolve: () => {},
    };
    getPlatformMock.mockReturnValue(
      new Promise<PlatformOrUnknown>((res) => {
        deferred.resolve = res;
      }),
    );
    commandsValue = [];

    // Act
    const { unmount } = renderHook(() => useSeedBootstrap());
    await waitFor(() => {
      expect(getPlatformMock).toHaveBeenCalled();
    });
    unmount();
    deferred.resolve("windows");
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    expect(initializeSeeds).not.toHaveBeenCalled();
  });
});
