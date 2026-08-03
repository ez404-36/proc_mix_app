import { beforeEach, describe, expect, it } from "vitest";
import { useMiniAppWindowStore } from "./miniappWindowStore";

beforeEach(() => {
  useMiniAppWindowStore.setState({ runningIds: new Set() });
});

describe("miniappWindowStore", () => {
  it("starts with no running mini-apps", () => {
    expect(useMiniAppWindowStore.getState().runningIds.size).toBe(0);
  });

  it("markOpened adds the id", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(true);
  });

  it("markOpened twice for the same id is idempotent", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    const first = useMiniAppWindowStore.getState().runningIds;
    useMiniAppWindowStore.getState().markOpened("ma-1");
    const second = useMiniAppWindowStore.getState().runningIds;
    expect(second).toBe(first);
    expect(second.size).toBe(1);
  });

  it("markClosed removes the id", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    useMiniAppWindowStore.getState().markClosed("ma-1");
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(false);
  });

  it("markClosed for an id that was never opened is a no-op", () => {
    const before = useMiniAppWindowStore.getState().runningIds;
    useMiniAppWindowStore.getState().markClosed("nope");
    expect(useMiniAppWindowStore.getState().runningIds).toBe(before);
  });

  it("tracks multiple ids independently", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    useMiniAppWindowStore.getState().markOpened("ma-2");
    useMiniAppWindowStore.getState().markClosed("ma-1");
    const { runningIds } = useMiniAppWindowStore.getState();
    expect(runningIds.has("ma-1")).toBe(false);
    expect(runningIds.has("ma-2")).toBe(true);
  });
});

describe("miniappWindowStore.reconcile", () => {
  it("replaces the running set with the given snapshot", () => {
    useMiniAppWindowStore.getState().markOpened("stale");
    useMiniAppWindowStore.getState().reconcile(["ma-1", "ma-2"]);
    const { runningIds } = useMiniAppWindowStore.getState();
    expect(runningIds.has("stale")).toBe(false);
    expect(runningIds.has("ma-1")).toBe(true);
    expect(runningIds.has("ma-2")).toBe(true);
    expect(runningIds.size).toBe(2);
  });

  it("clears everything when the snapshot is empty", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    useMiniAppWindowStore.getState().reconcile([]);
    expect(useMiniAppWindowStore.getState().runningIds.size).toBe(0);
  });

  it("is a no-op (keeps the same Set reference) when the snapshot already matches", () => {
    useMiniAppWindowStore.getState().markOpened("ma-1");
    const before = useMiniAppWindowStore.getState().runningIds;
    useMiniAppWindowStore.getState().reconcile(["ma-1"]);
    expect(useMiniAppWindowStore.getState().runningIds).toBe(before);
  });

  it("treats a differently-ORDERED snapshot as matching (set equality, not array equality)", () => {
    useMiniAppWindowStore.getState().reconcile(["ma-1", "ma-2"]);
    const before = useMiniAppWindowStore.getState().runningIds;
    useMiniAppWindowStore.getState().reconcile(["ma-2", "ma-1"]);
    expect(useMiniAppWindowStore.getState().runningIds).toBe(before);
  });
});
