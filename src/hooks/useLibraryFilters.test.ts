import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLibraryFilters } from "./useLibraryFilters";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useLibraryFilters", () => {
  it("starts empty when nothing is persisted yet", () => {
    const { result } = renderHook(() => useLibraryFilters("commands"));

    expect(result.current.query).toBe("");
    expect(result.current.activeTags).toEqual([]);
    expect(result.current.category).toBe("");
  });

  it("persists query/tags/category to localStorage under a per-tab key", () => {
    const { result } = renderHook(() => useLibraryFilters("workflows"));

    act(() => {
      result.current.setQuery("deploy");
      result.current.setActiveTags(["ci"]);
      result.current.setCategory("Build");
    });

    const raw = window.localStorage.getItem(
      "procmix-library-filters:workflows",
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      query: "deploy",
      activeTags: ["ci"],
      category: "Build",
    });
  });

  it("re-hydrates from localStorage on a fresh mount (simulating a tab switch remount)", () => {
    const first = renderHook(() => useLibraryFilters("miniapps"));
    act(() => {
      first.result.current.setQuery("vpn");
      first.result.current.setActiveTags(["network", "docker"]);
      first.result.current.setCategory("Networking");
    });
    first.unmount();

    const second = renderHook(() => useLibraryFilters("miniapps"));

    expect(second.result.current.query).toBe("vpn");
    expect(second.result.current.activeTags).toEqual(["network", "docker"]);
    expect(second.result.current.category).toBe("Networking");
  });

  it("keeps each tab's filters independent", () => {
    const commands = renderHook(() => useLibraryFilters("commands"));
    act(() => {
      commands.result.current.setQuery("build");
    });
    commands.unmount();

    const workflows = renderHook(() => useLibraryFilters("workflows"));

    expect(workflows.result.current.query).toBe("");
  });

  it("falls back to empty filters when the stored value is corrupt JSON", () => {
    window.localStorage.setItem(
      "procmix-library-filters:commands",
      "not json{{{",
    );

    const { result } = renderHook(() => useLibraryFilters("commands"));

    expect(result.current.query).toBe("");
    expect(result.current.activeTags).toEqual([]);
    expect(result.current.category).toBe("");
  });

  it("falls back to empty filters when the stored value has the wrong shape", () => {
    window.localStorage.setItem(
      "procmix-library-filters:commands",
      JSON.stringify({ query: 42, activeTags: "not-an-array" }),
    );

    const { result } = renderHook(() => useLibraryFilters("commands"));

    expect(result.current.query).toBe("");
    expect(result.current.activeTags).toEqual([]);
    expect(result.current.category).toBe("");
  });

  it("supports functional updates for setQuery/setActiveTags/setCategory", () => {
    const { result } = renderHook(() => useLibraryFilters("commands"));

    act(() => {
      result.current.setQuery((prev) => `${prev}x`);
      result.current.setActiveTags((prev) => [...prev, "a"]);
      result.current.setCategory((prev) => `${prev}Y`);
    });

    expect(result.current.query).toBe("x");
    expect(result.current.activeTags).toEqual(["a"]);
    expect(result.current.category).toBe("Y");
  });
});
