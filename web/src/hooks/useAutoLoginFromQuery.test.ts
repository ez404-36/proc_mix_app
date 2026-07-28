import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const validateSessionMock = vi.fn();
vi.mock("../api/client", () => ({
  validateSession: (token: string) => validateSessionMock(token),
}));

import { useAutoLoginFromQuery } from "./useAutoLoginFromQuery";
import { useAuthStore } from "../stores/authStore";

function setUrl(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => {
  validateSessionMock.mockReset();
  useAuthStore.setState({ token: null });
  setUrl("");
});

describe("useAutoLoginFromQuery", () => {
  it("does nothing while disabled", () => {
    setUrl("?token=abc");
    renderHook(() => useAutoLoginFromQuery(false));
    expect(validateSessionMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?token=abc");
  });

  it("does nothing when there is no token in the query", () => {
    renderHook(() => useAutoLoginFromQuery(true));
    expect(validateSessionMock).not.toHaveBeenCalled();
  });

  it("does nothing when a session token is already present", () => {
    useAuthStore.setState({ token: "existing" });
    setUrl("?token=abc");
    renderHook(() => useAutoLoginFromQuery(true));
    expect(validateSessionMock).not.toHaveBeenCalled();
  });

  it("on a valid candidate: commits the token and strips it from the URL", async () => {
    setUrl("?token=valid-token");
    validateSessionMock.mockResolvedValue(undefined);

    renderHook(() => useAutoLoginFromQuery(true));

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe("valid-token");
    });
    expect(window.location.search).toBe("");
  });

  it("on an invalid candidate: leaves the store empty, strips the token, no leak", async () => {
    setUrl("?token=bad-token");
    validateSessionMock.mockRejectedValue(new Error("unauthorized"));

    renderHook(() => useAutoLoginFromQuery(true));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("preserves other query params while stripping only token", async () => {
    setUrl("?token=valid-token&foo=bar");
    validateSessionMock.mockResolvedValue(undefined);

    renderHook(() => useAutoLoginFromQuery(true));

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe("valid-token");
    });
    expect(window.location.search).toBe("?foo=bar");
  });
});
