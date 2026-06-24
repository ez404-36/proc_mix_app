import { describe, expect, it } from "vitest";
import {
  isApiSlugConflictError,
  isValidApiSlug,
  sanitizeApiSlugInput,
} from "./apiSlug";

describe("isValidApiSlug", () => {
  it("accepts lowercase letters, digits, and hyphens", () => {
    expect(isValidApiSlug("deploy")).toBe(true);
    expect(isValidApiSlug("deploy-prod")).toBe(true);
    expect(isValidApiSlug("a1-b2-c3")).toBe(true);
    expect(isValidApiSlug("123")).toBe(true);
  });

  it("rejects empty, uppercase, spaces, and other characters", () => {
    expect(isValidApiSlug("")).toBe(false);
    expect(isValidApiSlug("Deploy")).toBe(false);
    expect(isValidApiSlug("deploy prod")).toBe(false);
    expect(isValidApiSlug("deploy_prod")).toBe(false);
    expect(isValidApiSlug("deploy!")).toBe(false);
    expect(isValidApiSlug("café")).toBe(false);
  });
});

describe("sanitizeApiSlugInput", () => {
  it("lowercases and strips disallowed characters", () => {
    expect(sanitizeApiSlugInput("My Deploy!")).toBe("mydeploy");
    expect(sanitizeApiSlugInput("Deploy-Prod_2")).toBe("deploy-prod2");
    expect(sanitizeApiSlugInput("  spaced  ")).toBe("spaced");
  });

  it("leaves an already-valid slug unchanged", () => {
    expect(sanitizeApiSlugInput("deploy-prod")).toBe("deploy-prod");
  });

  it("produces a value that passes isValidApiSlug when non-empty", () => {
    const cleaned = sanitizeApiSlugInput("A B-C!");
    expect(cleaned).toBe("ab-c");
    expect(isValidApiSlug(cleaned)).toBe(true);
  });
});

describe("isApiSlugConflictError", () => {
  it("detects a SQLite unique-constraint message", () => {
    expect(
      isApiSlugConflictError(
        new Error("upsert: error returned from database: (code 2067) UNIQUE constraint failed: commands.api_slug"),
      ),
    ).toBe(true);
  });

  it("detects the named partial index", () => {
    expect(isApiSlugConflictError("idx_commands_api_slug")).toBe(true);
    expect(isApiSlugConflictError("idx_workflows_api_slug")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isApiSlugConflictError(new Error("network down"))).toBe(false);
    expect(isApiSlugConflictError("PORT_IN_USE: 48610")).toBe(false);
  });
});
