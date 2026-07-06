import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSensitiveReveal } from "./useSensitiveReveal";

describe("useSensitiveReveal", () => {
  it("reports every key as masked initially", () => {
    const { result } = renderHook(() => useSensitiveReveal());

    expect(result.current.isRevealed("token")).toBe(false);
    expect(result.current.isRevealed("password")).toBe(false);
  });

  it("reveals a key when toggled from masked", () => {
    const { result } = renderHook(() => useSensitiveReveal());

    act(() => {
      result.current.toggle("token");
    });

    expect(result.current.isRevealed("token")).toBe(true);
  });

  it("masks a key again when toggled from revealed", () => {
    const { result } = renderHook(() => useSensitiveReveal());

    act(() => {
      result.current.toggle("token");
    });
    act(() => {
      result.current.toggle("token");
    });

    expect(result.current.isRevealed("token")).toBe(false);
  });

  it("tracks reveal state per key independently", () => {
    const { result } = renderHook(() => useSensitiveReveal());

    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });
    act(() => {
      result.current.toggle("b");
    });

    expect(result.current.isRevealed("a")).toBe(true);
    expect(result.current.isRevealed("b")).toBe(false);
    expect(result.current.isRevealed("c")).toBe(false);
  });

  it("keeps a stable toggle reference across renders", () => {
    const { result, rerender } = renderHook(() => useSensitiveReveal());
    const firstToggle = result.current.toggle;

    rerender();

    expect(result.current.toggle).toBe(firstToggle);
  });
});
