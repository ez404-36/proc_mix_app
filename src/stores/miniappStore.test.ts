import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid importing the real Tauri runtime indirectly.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// Mock the IPC repository so the store tests stay focused on state
// transitions; the wire format is exercised separately via the record
// converters (no dedicated repository test file yet — the Rust
// `wire_format_tests` in `storage/miniapps.rs` cover the wire contract).
const listMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../utils/miniappRepository", () => ({
  listMiniAppsFromDb: () => listMock(),
  saveMiniAppInDb: (ma: unknown) => saveMock(ma),
  deleteMiniAppInDb: (id: string) => deleteMock(id),
}));

// Mock Arco's Message so failure paths don't try to render a toast in jsdom.
const messageErrorMock = vi.fn();
vi.mock("@arco-design/web-react", () => ({
  Message: { error: (...args: unknown[]) => messageErrorMock(...args) },
}));

import type { MiniApp } from "../types";
import { useMiniAppStore } from "./miniappStore";

type NewMiniAppInput = Omit<
  MiniApp,
  "id" | "createdAt" | "updatedAt" | "runCount" | "lastRunAt"
>;

function baseInput(overrides: Partial<NewMiniAppInput> = {}): NewMiniAppInput {
  return {
    name: "VPN",
    widgets: [],
    tags: [],
    panelSize: { w: 400, h: 320 },
    favorite: false,
    ...overrides,
  };
}

beforeEach(() => {
  useMiniAppStore.setState({ miniapps: [], favorites: [], hydrated: true });
  listMock.mockReset();
  saveMock.mockReset();
  saveMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  messageErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("miniappStore.addMiniApp", () => {
  it("appends a mini-app with generated id, timestamps and runCount=0", () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    expect(created.id).toBeTypeOf("string");
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.runCount).toBe(0);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.lastRunAt).toBeUndefined();
    expect(useMiniAppStore.getState().miniapps).toHaveLength(1);
  });

  it("persists the new mini-app via saveMiniAppInDb", () => {
    useMiniAppStore.getState().addMiniApp(baseInput({ name: "Persisted" }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect((saveMock.mock.calls[0]?.[0] as MiniApp).name).toBe("Persisted");
  });

  it("adds a favourited mini-app to the favorites cache", () => {
    const created = useMiniAppStore
      .getState()
      .addMiniApp(baseInput({ favorite: true }));
    expect(useMiniAppStore.getState().favorites).toEqual([created.id]);
  });

  it("falls back to a Math.random id when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      const created = useMiniAppStore.getState().addMiniApp(baseInput());
      expect(created.id).toMatch(/^ma-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });

  it("surfaces a Message.error toast when persistence fails", async () => {
    saveMock.mockRejectedValueOnce(new Error("boom"));
    useMiniAppStore.getState().addMiniApp(baseInput());
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to save mini-app");
  });
});

describe("miniappStore.updateMiniApp", () => {
  it("patches a mini-app, refreshes updatedAt and returns before/after", async () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    saveMock.mockClear();
    await new Promise((r) => setTimeout(r, 5));
    const result = useMiniAppStore
      .getState()
      .updateMiniApp(created.id, { name: "Renamed" });
    expect(result?.before.name).toBe("VPN");
    expect(result?.after.name).toBe("Renamed");
    expect(result?.after.updatedAt).not.toBe(created.updatedAt);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op and returns null when the id does not exist", () => {
    const result = useMiniAppStore.getState().updateMiniApp("nope", { name: "x" });
    expect(result).toBeNull();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("miniappStore.deleteMiniApp", () => {
  it("removes a mini-app, drops it from favorites and returns the snapshot", () => {
    const created = useMiniAppStore
      .getState()
      .addMiniApp(baseInput({ favorite: true }));
    deleteMock.mockClear();
    const removed = useMiniAppStore.getState().deleteMiniApp(created.id);
    expect(removed?.id).toBe(created.id);
    expect(useMiniAppStore.getState().miniapps).toHaveLength(0);
    expect(useMiniAppStore.getState().favorites).toEqual([]);
    expect(deleteMock).toHaveBeenCalledWith(created.id);
  });

  it("returns null but still issues the delete IPC for an unknown id", () => {
    const removed = useMiniAppStore.getState().deleteMiniApp("nope");
    expect(removed).toBeNull();
    expect(deleteMock).toHaveBeenCalledWith("nope");
  });

  it("surfaces a Message.error toast when persistence fails", async () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    deleteMock.mockRejectedValueOnce(new Error("boom"));
    useMiniAppStore.getState().deleteMiniApp(created.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to delete mini-app");
  });
});

describe("miniappStore.toggleFavorite", () => {
  it("flips favorite, syncs the favorites cache and persists", () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    saveMock.mockClear();
    useMiniAppStore.getState().toggleFavorite(created.id);
    const updated = useMiniAppStore
      .getState()
      .miniapps.find((m) => m.id === created.id);
    expect(updated?.favorite).toBe(true);
    expect(useMiniAppStore.getState().favorites).toEqual([created.id]);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("toggling twice returns to the original state", () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    useMiniAppStore.getState().toggleFavorite(created.id);
    useMiniAppStore.getState().toggleFavorite(created.id);
    const updated = useMiniAppStore
      .getState()
      .miniapps.find((m) => m.id === created.id);
    expect(updated?.favorite).toBe(false);
    expect(useMiniAppStore.getState().favorites).toEqual([]);
  });
});

describe("miniappStore.markMiniAppRun", () => {
  it("increments runCount and sets lastRunAt", () => {
    const created = useMiniAppStore.getState().addMiniApp(baseInput());
    useMiniAppStore.getState().markMiniAppRun(created.id);
    const updated = useMiniAppStore
      .getState()
      .miniapps.find((m) => m.id === created.id);
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastRunAt).toBeTypeOf("string");
  });

  it("is a no-op when the id does not exist", () => {
    useMiniAppStore.getState().addMiniApp(baseInput());
    saveMock.mockClear();
    useMiniAppStore.getState().markMiniAppRun("nope");
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("miniappStore.hydrateFromDb", () => {
  beforeEach(() => {
    useMiniAppStore.setState({ miniapps: [], favorites: [], hydrated: false });
  });

  it("loads mini-apps from the repository, computes favorites and marks hydrated", async () => {
    const fixture: MiniApp = {
      id: "from-db",
      name: "Loaded",
      panelSize: { w: 400, h: 320 },
      widgets: [],
      tags: [],
      favorite: true,
      createdAt: "2026-07-30T00:00:00Z",
      updatedAt: "2026-07-30T00:00:00Z",
      runCount: 0,
    };
    listMock.mockResolvedValueOnce([fixture]);
    await useMiniAppStore.getState().hydrateFromDb();
    expect(useMiniAppStore.getState().miniapps).toEqual([fixture]);
    expect(useMiniAppStore.getState().favorites).toEqual(["from-db"]);
    expect(useMiniAppStore.getState().hydrated).toBe(true);
  });

  it("flips hydrated=true even when the IPC call rejects", async () => {
    listMock.mockRejectedValueOnce(new Error("ipc-down"));
    await useMiniAppStore.getState().hydrateFromDb();
    expect(useMiniAppStore.getState().hydrated).toBe(true);
    expect(useMiniAppStore.getState().miniapps).toEqual([]);
  });
});
