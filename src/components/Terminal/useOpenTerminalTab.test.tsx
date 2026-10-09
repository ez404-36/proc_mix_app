import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../i18n";
import {
  describeTerminalSession,
  spawnTerminalSession,
  terminalBridgeReady,
} from "../../services/terminalService";
import { useTerminalStore } from "../../stores/terminalStore";
import { useOpenTerminalTab } from "./useOpenTerminalTab";

vi.mock("../../services/terminalService", () => ({
  describeTerminalSession: vi.fn(),
  spawnTerminalSession: vi.fn(),
  terminalBridgeReady: vi.fn(),
}));

const describeMock = vi.mocked(describeTerminalSession);
const spawnMock = vi.mocked(spawnTerminalSession);
const bridgeMock = vi.mocked(terminalBridgeReady);

function resetTerminalStore(): void {
  useTerminalStore.setState({
    panelMode: "terminal",
    sessions: {},
    regions: {},
    layoutRoot: null,
    activeRegionId: null,
    reservedTabNumbers: new Set(),
    hasAutoOpenedTab: true,
    lastCommands: {},
    inputLines: {},
  });
}

function seedRegion(regionId: string, sessionId: string): void {
  useTerminalStore.setState({
    sessions: {
      [sessionId]: {
        id: sessionId,
        title: `Terminal ${sessionId}`,
        number: 1,
        createdAt: 1,
        exited: false,
      },
    },
    regions: { [regionId]: { id: regionId, tabIds: [sessionId], activeTabId: sessionId } },
    layoutRoot: { type: "region", regionId },
    activeRegionId: regionId,
  });
}

describe("useOpenTerminalTab", () => {
  beforeEach(() => {
    resetTerminalStore();
    bridgeMock.mockReset().mockResolvedValue(undefined);
    describeMock.mockReset().mockResolvedValue(null);
    spawnMock.mockReset().mockResolvedValue("new-session");
  });

  it("spawns a new terminal in the active terminal's cwd", async () => {
    seedRegion("region-1", "session-1");
    describeMock.mockResolvedValue({
      cwd: "/current/project",
      remoteCommand: null,
    });
    const { result } = renderHook(() => useOpenTerminalTab());

    act(() => {
      result.current();
    });

    await waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(describeMock).toHaveBeenCalledWith("session-1");
    expect(spawnMock).toHaveBeenCalledWith(undefined, "/current/project");
  });

  it("uses the explicitly requested region rather than the active one", async () => {
    seedRegion("region-active", "session-active");
    useTerminalStore.setState({
      sessions: {
        ...useTerminalStore.getState().sessions,
        "session-region": {
          id: "session-region",
          title: "Terminal 2",
          number: 2,
          createdAt: 2,
          exited: false,
        },
      },
      regions: {
        "region-active": {
          id: "region-active",
          tabIds: ["session-active"],
          activeTabId: "session-active",
        },
        "region-requested": {
          id: "region-requested",
          tabIds: ["session-region"],
          activeTabId: "session-region",
        },
      },
      layoutRoot: null,
    });
    describeMock.mockResolvedValue({ cwd: "/requested", remoteCommand: null });
    const { result } = renderHook(() => useOpenTerminalTab());

    act(() => {
      result.current("region-requested");
    });

    await waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(describeMock).toHaveBeenCalledWith("session-region");
    expect(spawnMock).toHaveBeenCalledWith(undefined, "/requested");
  });

  it("falls back to the home directory when cwd is unobservable", async () => {
    seedRegion("region-1", "session-1");
    describeMock.mockResolvedValue({ cwd: null, remoteCommand: null });
    const { result } = renderHook(() => useOpenTerminalTab());

    act(() => {
      result.current();
    });

    await waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(spawnMock).toHaveBeenCalledWith(undefined, undefined);
  });
});
