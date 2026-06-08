import { describe, expect, it } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(350)).toBe("350 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("renders one-second-and-over in seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(13682)).toBe("13.7 s");
  });
});
