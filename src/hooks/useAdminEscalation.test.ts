import { renderHook, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hasAdminPasswordMock = vi.fn<() => Promise<boolean>>();
vi.mock("../utils/adminPassword", () => ({
  hasAdminPassword: () => hasAdminPasswordMock(),
}));

import { useAdminEscalation } from "./useAdminEscalation";
import type { FormState } from "../types/commandForm";

function makeForm(overrides: Partial<FormState>): FormState {
  return {
    name: "",
    description: "",
    script: "",
    shell: "bash",
    tags: [],
    category: "",
    runAsAdmin: false,
    variables: [],
    timeoutSeconds: "",
    disableHints: false,
    outputSchema: undefined,
    envRows: [],
    workingDir: "",
    promptWorkingDir: false,
    target: { kind: "local" },
    promptSshPassword: false,
    apiEnabled: false,
    apiSlug: "",
    explorerEnabled: false,
    explorerPathVariable: "",
    sound: undefined,
    ...overrides,
  };
}

function useAdminHarness(initial: Partial<FormState>) {
  const [form, setForm] = useState<FormState>(() => makeForm(initial));
  const api = useAdminEscalation(form, setForm);
  return { form, api };
}

beforeEach(() => {
  hasAdminPasswordMock.mockReset();
  hasAdminPasswordMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAdminEscalation", () => {
  it("reflects a stored admin password once the keychain resolves true", async () => {
    hasAdminPasswordMock.mockResolvedValue(true);
    const { result } = renderHook(() => useAdminHarness({}));

    expect(result.current.api.adminPasswordStored).toBe(false);
    await waitFor(() =>
      expect(result.current.api.adminPasswordStored).toBe(true),
    );
  });

  it("treats a rejected keychain lookup as no stored password", async () => {
    hasAdminPasswordMock.mockRejectedValue(new Error("no dbus"));
    const { result } = renderHook(() => useAdminHarness({}));

    await waitFor(() => expect(hasAdminPasswordMock).toHaveBeenCalled());
    expect(result.current.api.adminPasswordStored).toBe(false);
  });

  it("does not report escalation for a plain script", () => {
    const { result } = renderHook(() =>
      useAdminHarness({ script: "ls -la" }),
    );

    expect(result.current.api.escalationDetected).toBe(false);
    expect(result.current.form.runAsAdmin).toBe(false);
  });

  it("auto-enables runAsAdmin when the script escalates inline", async () => {
    const { result } = renderHook(() =>
      useAdminHarness({ script: "sudo apt update" }),
    );

    expect(result.current.api.escalationDetected).toBe(true);
    await waitFor(() => expect(result.current.form.runAsAdmin).toBe(true));
  });

  it("does not re-toggle runAsAdmin when it is already enabled", async () => {
    const { result } = renderHook(() =>
      useAdminHarness({ script: "sudo apt update", runAsAdmin: true }),
    );

    expect(result.current.api.escalationDetected).toBe(true);
    expect(result.current.form.runAsAdmin).toBe(true);
  });

  it("exposes a setter that overrides the stored flag", async () => {
    const { result } = renderHook(() => useAdminHarness({}));

    await waitFor(() => expect(hasAdminPasswordMock).toHaveBeenCalled());
    act(() => {
      result.current.api.setAdminPasswordStored(true);
    });

    expect(result.current.api.adminPasswordStored).toBe(true);
  });

  it("re-checks the keychain when runAsAdmin toggles", async () => {
    const setForm = vi.fn();
    const { rerender } = renderHook(
      ({ runAsAdmin }: { runAsAdmin: boolean }) =>
        useAdminEscalation(makeForm({ runAsAdmin }), setForm),
      { initialProps: { runAsAdmin: false } },
    );

    await waitFor(() => expect(hasAdminPasswordMock).toHaveBeenCalledTimes(1));

    rerender({ runAsAdmin: true });

    await waitFor(() =>
      expect(hasAdminPasswordMock).toHaveBeenCalledTimes(2),
    );
  });
});
