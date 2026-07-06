import { renderHook, act } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useVariableRows } from "./useVariableRows";
import type { FormState, VariableRow } from "../types/commandForm";

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

function variable(overrides: Partial<VariableRow>): VariableRow {
  return {
    rowId: overrides.rowId ?? "row-0",
    name: "",
    defaultValue: "",
    description: "",
    sensitive: false,
    promptAtRuntime: true,
    nameTouched: false,
    ...overrides,
  };
}

function useVariableRowsHarness(initial: Partial<FormState>) {
  const [form, setForm] = useState<FormState>(() => makeForm(initial));
  const api = useVariableRows(setForm);
  return { form, api };
}

describe("useVariableRows", () => {
  it("appends a fresh prompt-at-runtime row on add", () => {
    const { result } = renderHook(() => useVariableRowsHarness({}));

    act(() => {
      result.current.api.handleVariableAdd();
    });

    expect(result.current.form.variables).toHaveLength(1);
    expect(result.current.form.variables[0]).toMatchObject({
      name: "",
      defaultValue: "",
      description: "",
      sensitive: false,
      promptAtRuntime: true,
      nameTouched: false,
    });
    expect(result.current.form.variables[0].rowId).toEqual(expect.any(String));
  });

  it("removes the variable row at the given index", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        variables: [
          variable({ rowId: "a", name: "A" }),
          variable({ rowId: "b", name: "B" }),
        ],
      }),
    );

    act(() => {
      result.current.api.handleVariableRemove(0);
    });

    expect(result.current.form.variables).toHaveLength(1);
    expect(result.current.form.variables[0].rowId).toBe("b");
  });

  it("patches a non-defaultValue field without touching the script", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        script: "echo ${NAME}",
        variables: [variable({ name: "NAME" })],
      }),
    );

    act(() => {
      result.current.api.updateVariableRow(0, { sensitive: true });
    });

    expect(result.current.form.variables[0].sensitive).toBe(true);
    expect(result.current.form.script).toBe("echo ${NAME}");
  });

  it("syncs the script when a named row's defaultValue changes", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        script: "echo ${NAME}",
        variables: [variable({ name: "NAME" })],
      }),
    );

    act(() => {
      result.current.api.updateVariableRow(0, { defaultValue: "hi" });
    });

    expect(result.current.form.variables[0].defaultValue).toBe("hi");
    expect(result.current.form.script).toBe("echo ${NAME:hi}");
  });

  it("clears the inline default in the script when defaultValue becomes empty", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        script: "echo ${NAME:old}",
        variables: [variable({ name: "NAME", defaultValue: "old" })],
      }),
    );

    act(() => {
      result.current.api.updateVariableRow(0, { defaultValue: "" });
    });

    expect(result.current.form.script).toBe("echo ${NAME}");
  });

  it("does not sync the script when the changed row has no name", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        script: "echo ${NAME}",
        variables: [variable({ name: "" })],
      }),
    );

    act(() => {
      result.current.api.updateVariableRow(0, { defaultValue: "hi" });
    });

    expect(result.current.form.variables[0].defaultValue).toBe("hi");
    expect(result.current.form.script).toBe("echo ${NAME}");
  });

  it("treats an undefined defaultValue patch as an empty replacement", () => {
    const { result } = renderHook(() =>
      useVariableRowsHarness({
        script: "echo ${NAME:old}",
        variables: [variable({ name: "NAME", defaultValue: "old" })],
      }),
    );

    act(() => {
      result.current.api.updateVariableRow(0, { defaultValue: undefined });
    });

    expect(result.current.form.script).toBe("echo ${NAME}");
  });

  it("keeps stable callback references across renders", () => {
    const { result, rerender } = renderHook(() =>
      useVariableRowsHarness({}),
    );
    const { handleVariableAdd, handleVariableRemove, updateVariableRow } =
      result.current.api;

    rerender();

    expect(result.current.api.handleVariableAdd).toBe(handleVariableAdd);
    expect(result.current.api.handleVariableRemove).toBe(handleVariableRemove);
    expect(result.current.api.updateVariableRow).toBe(updateVariableRow);
  });
});
