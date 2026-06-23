import { describe, expect, it } from "vitest";
import {
  INVALID_REMOTE_TARGET_PREFIX,
  REMOTE_ELEVATION_UNSUPPORTED,
  REMOTE_TARGET_UNRESOLVED,
  SSH_PASSWORD_BACKEND_PREFIX,
  isRemoteElevationUnsupportedError,
  isRemoteTargetUnresolvedError,
  parseInvalidRemoteTargetError,
  parseSshPasswordBackendError,
} from "./remoteTarget";

describe("parseInvalidRemoteTargetError", () => {
  it("extracts the alias from an Error carrying the prefix", () => {
    const err = new Error(`${INVALID_REMOTE_TARGET_PREFIX}bad host`);
    expect(parseInvalidRemoteTargetError(err)).toBe("bad host");
  });

  it("extracts the alias from a raw string", () => {
    expect(parseInvalidRemoteTargetError("INVALID_REMOTE_TARGET:-x")).toBe("-x");
  });

  it("returns an empty string when the prefix has no alias portion", () => {
    expect(parseInvalidRemoteTargetError("INVALID_REMOTE_TARGET:")).toBe("");
  });

  it("returns null for an unrelated error", () => {
    expect(parseInvalidRemoteTargetError(new Error("boom"))).toBeNull();
    expect(parseInvalidRemoteTargetError(REMOTE_TARGET_UNRESOLVED)).toBeNull();
  });
});

describe("isRemoteElevationUnsupportedError", () => {
  it("matches the exact sentinel as Error or string", () => {
    expect(
      isRemoteElevationUnsupportedError(new Error(REMOTE_ELEVATION_UNSUPPORTED)),
    ).toBe(true);
    expect(isRemoteElevationUnsupportedError(REMOTE_ELEVATION_UNSUPPORTED)).toBe(
      true,
    );
  });

  it("does not match a different sentinel or a wrapping message", () => {
    expect(isRemoteElevationUnsupportedError(REMOTE_TARGET_UNRESOLVED)).toBe(
      false,
    );
    expect(
      isRemoteElevationUnsupportedError(
        new Error(`Failed: ${REMOTE_ELEVATION_UNSUPPORTED}`),
      ),
    ).toBe(false);
  });
});

describe("isRemoteTargetUnresolvedError", () => {
  it("matches the exact sentinel as Error or string", () => {
    expect(
      isRemoteTargetUnresolvedError(new Error(REMOTE_TARGET_UNRESOLVED)),
    ).toBe(true);
    expect(isRemoteTargetUnresolvedError(REMOTE_TARGET_UNRESOLVED)).toBe(true);
  });

  it("does not match a different sentinel", () => {
    expect(isRemoteTargetUnresolvedError(REMOTE_ELEVATION_UNSUPPORTED)).toBe(
      false,
    );
  });
});

describe("parseSshPasswordBackendError", () => {
  it("extracts the backend message from an Error carrying the prefix", () => {
    const err = new Error(`${SSH_PASSWORD_BACKEND_PREFIX}no secret service`);
    expect(parseSshPasswordBackendError(err)).toBe("no secret service");
  });

  it("returns an empty string when the prefix has no suffix", () => {
    expect(parseSshPasswordBackendError("SSH_PASSWORD_BACKEND:")).toBe("");
  });

  it("returns null for an unrelated error", () => {
    expect(parseSshPasswordBackendError(new Error("boom"))).toBeNull();
    expect(parseSshPasswordBackendError(REMOTE_TARGET_UNRESOLVED)).toBeNull();
  });
});
