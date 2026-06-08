import { describe, expect, it } from "vitest";
import { paginate } from "./paginate";

const range = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  it("returns the requested page of the given size", () => {
    const result = paginate(range(25), 2, 10);
    expect(result.pageItems).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(2);
  });

  it("returns a short final page", () => {
    const result = paginate(range(25), 3, 10);
    expect(result.pageItems).toEqual([21, 22, 23, 24, 25]);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(3);
  });

  it("clamps a page above the range to the last page", () => {
    const result = paginate(range(12), 99, 10);
    expect(result.page).toBe(2);
    expect(result.pageItems).toEqual([11, 12]);
  });

  it("clamps a page below 1 to the first page", () => {
    const result = paginate(range(12), 0, 10);
    expect(result.page).toBe(1);
    expect(result.pageItems).toEqual(range(10));
  });

  it("resolves an empty list to page 1 with one total page", () => {
    const result = paginate([], 1, 10);
    expect(result.pageItems).toEqual([]);
    expect(result.totalPages).toBe(1);
    expect(result.page).toBe(1);
  });

  it("honours a page size of 25", () => {
    const result = paginate(range(30), 2, 25);
    expect(result.pageItems).toEqual([26, 27, 28, 29, 30]);
    expect(result.totalPages).toBe(2);
  });

  it("treats a non-positive page size as 1", () => {
    const result = paginate(range(3), 1, 0);
    expect(result.totalPages).toBe(3);
    expect(result.pageItems).toEqual([1]);
  });

  it("does not mutate the input array", () => {
    const items = range(5);
    paginate(items, 1, 2);
    expect(items).toEqual(range(5));
  });
});
