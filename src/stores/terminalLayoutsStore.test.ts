// Unit tests for the terminal layouts store — a thin DB-backed client.
// The service layer is mocked; the tests pin the list bookkeeping
// (sort order, active id transitions) and dirty detection.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalLayoutDto, TerminalLayoutState } from "../types/terminalLayout";

const mockService = vi.hoisted(() => ({
  listTerminalLayouts: vi.fn(),
  saveTerminalLayout: vi.fn(),
  renameTerminalLayout: vi.fn(),
  deleteTerminalLayout: vi.fn(),
}));

vi.mock("../services/terminalLayoutsService", () => mockService);

import { useTerminalLayoutsStore } from "./terminalLayoutsStore";

function dto(id: string, name: string, patch: Partial<TerminalLayoutDto> = {}): TerminalLayoutDto {
  return {
    id,
    name,
    position: "bottom",
    fullscreen: false,
    size: { height: 360 },
    layout: { type: "region", tabs: [{}], activeTabIndex: 0 },
    createdAt: "2026-09-10T00:00:00+00:00",
    updatedAt: "2026-09-10T00:00:00+00:00",
    ...patch,
  };
}

const currentState: TerminalLayoutState = {
  position: "bottom",
  fullscreen: false,
  size: { height: 360 },
  layout: { type: "region", tabs: [{}], activeTabIndex: 0 },
};

function reset(): void {
  useTerminalLayoutsStore.setState({
    layouts: [],
    activeLayoutId: null,
    isLoading: false,
  });
  vi.clearAllMocks();
}

describe("terminalLayoutsStore", () => {
  beforeEach(reset);

  it("load fills the list and tolerates re-entry while loading", async () => {
    mockService.listTerminalLayouts.mockResolvedValue([dto("b", "Beta"), dto("a", "Alpha")]);
    await useTerminalLayoutsStore.getState().load();
    expect(useTerminalLayoutsStore.getState().layouts.map((l) => l.id)).toEqual(["b", "a"]);
    expect(useTerminalLayoutsStore.getState().isLoading).toBe(false);
    expect(mockService.listTerminalLayouts).toHaveBeenCalledTimes(1);
  });

  it("load keeps stale data and clears the spinner on error", async () => {
    mockService.listTerminalLayouts.mockResolvedValue([dto("b", "Beta")]);
    await useTerminalLayoutsStore.getState().load();
    mockService.listTerminalLayouts.mockRejectedValue(new Error("db down"));
    await expect(useTerminalLayoutsStore.getState().load()).rejects.toThrow("db down");
    expect(useTerminalLayoutsStore.getState().layouts).toHaveLength(1);
    expect(useTerminalLayoutsStore.getState().isLoading).toBe(false);
  });

  it("saveAs appends name-sorted and marks the new layout active", async () => {
    useTerminalLayoutsStore.setState({ layouts: [dto("b", "Beta")] });
    mockService.saveTerminalLayout.mockResolvedValue(dto("a", "Alpha"));
    const saved = await useTerminalLayoutsStore.getState().saveAs("Alpha", currentState);
    expect(saved.id).toBe("a");
    const s = useTerminalLayoutsStore.getState();
    expect(s.layouts.map((l) => l.id)).toEqual(["a", "b"]);
    expect(s.activeLayoutId).toBe("a");
    expect(mockService.saveTerminalLayout).toHaveBeenCalledWith({
      name: "Alpha",
      ...currentState,
    });
  });

  it("update overwrites in place and keeps the layout active", async () => {
    useTerminalLayoutsStore.setState({ layouts: [dto("a", "Alpha")], activeLayoutId: null });
    const updated = dto("a", "Alpha", { size: { height: 720 } });
    mockService.saveTerminalLayout.mockResolvedValue(updated);
    await useTerminalLayoutsStore.getState().update("a", {
      ...currentState,
      size: { height: 720 },
    });
    expect(mockService.saveTerminalLayout).toHaveBeenCalledWith({
      id: "a",
      name: "Alpha",
      ...currentState,
      size: { height: 720 },
    });
    const s = useTerminalLayoutsStore.getState();
    expect(s.layouts[0].size).toEqual({ height: 720 });
    expect(s.activeLayoutId).toBe("a");
  });

  it("rename replaces the record; remove clears it and the active pointer", async () => {
    useTerminalLayoutsStore.setState({ layouts: [dto("a", "Alpha")], activeLayoutId: "a" });
    mockService.renameTerminalLayout.mockResolvedValue(dto("a", "Gamma"));
    await useTerminalLayoutsStore.getState().rename("a", "Gamma");
    expect(useTerminalLayoutsStore.getState().layouts[0].name).toBe("Gamma");

    mockService.deleteTerminalLayout.mockResolvedValue(undefined);
    await useTerminalLayoutsStore.getState().remove("a");
    const s = useTerminalLayoutsStore.getState();
    expect(s.layouts).toEqual([]);
    expect(s.activeLayoutId).toBeNull();
  });

  it("isDirtyFor detects display/snapshot changes and unknown ids", () => {
    useTerminalLayoutsStore.setState({ layouts: [dto("a", "Alpha")] });
    const { isDirtyFor } = useTerminalLayoutsStore.getState();
    expect(isDirtyFor("a", currentState)).toBe(false);
    expect(isDirtyFor("a", { ...currentState, position: "left" })).toBe(true);
    expect(
      isDirtyFor("a", {
        ...currentState,
        layout: { type: "region", tabs: [{}, {}], activeTabIndex: 0 },
      }),
    ).toBe(true);
    expect(isDirtyFor("missing", currentState)).toBe(false);
  });
});
