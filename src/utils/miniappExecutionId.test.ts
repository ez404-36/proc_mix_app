import { describe, expect, it } from "vitest";
import {
  makeMiniAppExecutionId,
  parseMiniAppExecutionId,
} from "./miniappExecutionId";

describe("makeMiniAppExecutionId / parseMiniAppExecutionId", () => {
  it("round-trips the mini-app id through a minted execution id", () => {
    const id = makeMiniAppExecutionId("ma-1");
    expect(parseMiniAppExecutionId(id)).toEqual({ miniAppId: "ma-1" });
  });

  it("mints a distinct id on every call", () => {
    const a = makeMiniAppExecutionId("ma-1");
    const b = makeMiniAppExecutionId("ma-1");
    expect(a).not.toBe(b);
  });

  it("prefixes with the documented mawin: scheme", () => {
    const id = makeMiniAppExecutionId("ma-1");
    expect(id.startsWith("mawin:ma-1:")).toBe(true);
  });

  it("returns null for a plain (untagged) execution id", () => {
    expect(parseMiniAppExecutionId("exec-1234")).toBeNull();
  });

  it("returns null for an inline-command-style id", () => {
    expect(parseMiniAppExecutionId("ma-inline-abc123-1690000000000")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseMiniAppExecutionId("")).toBeNull();
  });

  it("returns null when the mawin prefix has no mini-app id segment", () => {
    expect(parseMiniAppExecutionId("mawin:")).toBeNull();
  });
});
