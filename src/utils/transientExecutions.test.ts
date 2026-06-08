import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetTransientRegistryForTests,
  isTransient,
  markTransient,
  unmarkTransient,
} from "./transientExecutions";

beforeEach(() => {
  __resetTransientRegistryForTests();
});

describe("transientExecutions registry", () => {
  it("isTransient returns false for unknown ids", () => {
    expect(isTransient("never-marked")).toBe(false);
  });

  it("markTransient followed by isTransient returns true", () => {
    markTransient("abc");
    expect(isTransient("abc")).toBe(true);
  });

  it("markTransient is idempotent on repeated calls", () => {
    markTransient("abc");
    markTransient("abc");
    expect(isTransient("abc")).toBe(true);
    unmarkTransient("abc");
    // One unmark clears the single Set entry — repeated marks don't stack.
    expect(isTransient("abc")).toBe(false);
  });

  it("unmarkTransient removes the entry", () => {
    markTransient("abc");
    unmarkTransient("abc");
    expect(isTransient("abc")).toBe(false);
  });

  it("unmarkTransient on an unknown id is a no-op (does not throw)", () => {
    expect(() => unmarkTransient("never-marked")).not.toThrow();
  });

  it("isolates ids from each other", () => {
    markTransient("a");
    markTransient("b");
    unmarkTransient("a");
    expect(isTransient("a")).toBe(false);
    expect(isTransient("b")).toBe(true);
  });
});
