import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri IPC before importing the module under test so its
// import-time invoke binding sees the mock. The actual `invoke` call
// shape is the boundary we want to cross — anything else (the JSON
// wire format, the Rust-side handler) is verified on the Rust side
// via wire-format tests.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  ADMIN_PASSWORD_BACKEND_PREFIX,
  ADMIN_PASSWORD_REQUIRED,
  clearAdminPassword,
  hasAdminPassword,
  isAdminPasswordRequiredError,
  setAdminPassword,
} from "./adminPassword";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("hasAdminPassword", () => {
  // Confirms the IPC contract: command name is `admin_password_status`
  // (matches `#[tauri::command] pub fn admin_password_status` on the
  // Rust side). Whatever the Rust returns flows through unchanged.
  it("invokes admin_password_status and returns the boolean as-is", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const result = await hasAdminPassword();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("admin_password_status", undefined);
    expect(result).toBe(true);
  });

  it("returns false when nothing is stored", async () => {
    invokeMock.mockResolvedValueOnce(false);
    expect(await hasAdminPassword()).toBe(false);
  });
});

describe("setAdminPassword", () => {
  // The Rust handler's parameter is `password: String`, so the JS
  // payload key MUST be `password` (camelCase rename has nothing to
  // do here because the name is already a single token).
  it("invokes set_admin_password with the password under the `password` key", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await setAdminPassword("hunter2");
    expect(invokeMock).toHaveBeenCalledWith("set_admin_password", {
      password: "hunter2",
    });
  });

  // Empty-string rejection happens on the Rust side; the JS wrapper
  // doesn't pre-validate (would be redundant given the Rust source of
  // truth, and the Settings UI also blocks empty submits). Confirm
  // the error propagates as a rejection.
  it("propagates a rejection from invoke", async () => {
    invokeMock.mockRejectedValueOnce("password cannot be empty");
    await expect(setAdminPassword("")).rejects.toBe(
      "password cannot be empty",
    );
  });
});

describe("clearAdminPassword", () => {
  it("invokes clear_admin_password with no arguments", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await clearAdminPassword();
    expect(invokeMock).toHaveBeenCalledWith("clear_admin_password", undefined);
  });
});

describe("isAdminPasswordRequiredError", () => {
  // The sentinel detector is the SINGLE point where the JS bridge
  // decides whether to open the password prompt. A regression here
  // (e.g. accepting `null` or partial substring matches) would either
  // miss the prompt for legitimate cases or open it for unrelated
  // errors.
  it("matches an Error whose message equals the sentinel exactly", () => {
    const err = new Error(ADMIN_PASSWORD_REQUIRED);
    expect(isAdminPasswordRequiredError(err)).toBe(true);
  });

  it("matches a plain string equal to the sentinel", () => {
    // Tauri commands that return Result<_, String> deliver the error
    // as a bare string on the JS side, not wrapped in Error.
    expect(isAdminPasswordRequiredError(ADMIN_PASSWORD_REQUIRED)).toBe(true);
  });

  it("does not match a similar but non-equal message", () => {
    expect(isAdminPasswordRequiredError("ADMIN_PASSWORD_REQUIRED ")).toBe(
      false,
    );
    expect(isAdminPasswordRequiredError("admin_password_required")).toBe(false);
    expect(isAdminPasswordRequiredError("ADMIN_PASSWORD")).toBe(false);
  });

  it("does not match the backend-error prefix on its own", () => {
    // The backend prefix is a separate failure mode and should NOT
    // trigger the password prompt — it means the keychain itself is
    // broken, not that we need to ask the user for input.
    expect(
      isAdminPasswordRequiredError(
        `${ADMIN_PASSWORD_BACKEND_PREFIX}D-Bus unavailable`,
      ),
    ).toBe(false);
  });

  it("returns false for null/undefined/non-error values", () => {
    expect(isAdminPasswordRequiredError(null)).toBe(false);
    expect(isAdminPasswordRequiredError(undefined)).toBe(false);
    expect(isAdminPasswordRequiredError(42)).toBe(false);
    expect(isAdminPasswordRequiredError({})).toBe(false);
  });
});

describe("sentinel constants", () => {
  // Lock the literal so the cross-boundary contract with Rust stays
  // stable. The matching Rust test
  // (`admin_password_required_sentinel_is_exact`) pins the same
  // string — both tests must change in lockstep.
  it("ADMIN_PASSWORD_REQUIRED is the documented literal", () => {
    expect(ADMIN_PASSWORD_REQUIRED).toBe("ADMIN_PASSWORD_REQUIRED");
  });
  it("ADMIN_PASSWORD_BACKEND_PREFIX is the documented literal", () => {
    expect(ADMIN_PASSWORD_BACKEND_PREFIX).toBe("ADMIN_PASSWORD_BACKEND:");
  });
});
