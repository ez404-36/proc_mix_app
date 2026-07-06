import { renderHook, act } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useEnvRows } from "./useEnvRows";
import type { EnvRow, FormState } from "../types/commandForm";

function makeForm(envRows: EnvRow[]): FormState {
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
    envRows,
    workingDir: "",
    promptWorkingDir: false,
    target: { kind: "local" },
    promptSshPassword: false,
    apiEnabled: false,
    apiSlug: "",
    explorerEnabled: false,
    explorerPathVariable: "",
    sound: undefined,
  };
}

function row(key: string, value: string): EnvRow {
  return { rowId: `row-${key}`, key, value };
}

/**
 * Drive the hook via a real `useState<FormState>` so each mutation
 * callback can be asserted against the resulting form snapshot.
 */
function useEnvRowsHarness(initial: EnvRow[]) {
  const [form, setForm] = useState<FormState>(() => makeForm(initial));
  const api = useEnvRows(setForm);
  return { form, api };
}

describe("useEnvRows", () => {
  it("appends a fresh empty row on add", () => {
    const { result } = renderHook(() => useEnvRowsHarness([]));

    act(() => {
      result.current.api.handleEnvRowAdd();
    });

    expect(result.current.form.envRows).toHaveLength(1);
    expect(result.current.form.envRows[0]).toMatchObject({
      key: "",
      value: "",
    });
    expect(result.current.form.envRows[0].rowId).toEqual(expect.any(String));
  });

  it("preserves existing rows when adding another", () => {
    const { result } = renderHook(() =>
      useEnvRowsHarness([row("A", "1")]),
    );

    act(() => {
      result.current.api.handleEnvRowAdd();
    });

    expect(result.current.form.envRows).toHaveLength(2);
    expect(result.current.form.envRows[0]).toEqual(row("A", "1"));
  });

  it("removes the row at the given index", () => {
    const { result } = renderHook(() =>
      useEnvRowsHarness([row("A", "1"), row("B", "2"), row("C", "3")]),
    );

    act(() => {
      result.current.api.handleEnvRowRemove(1);
    });

    expect(result.current.form.envRows).toEqual([
      row("A", "1"),
      row("C", "3"),
    ]);
  });

  it("leaves the list unchanged when removing an out-of-range index", () => {
    const { result } = renderHook(() =>
      useEnvRowsHarness([row("A", "1")]),
    );

    act(() => {
      result.current.api.handleEnvRowRemove(5);
    });

    expect(result.current.form.envRows).toEqual([row("A", "1")]);
  });

  it("patches only the targeted row's key", () => {
    const { result } = renderHook(() =>
      useEnvRowsHarness([row("A", "1"), row("B", "2")]),
    );

    act(() => {
      result.current.api.updateEnvRow(0, { key: "RENAMED" });
    });

    expect(result.current.form.envRows[0]).toEqual({
      rowId: "row-A",
      key: "RENAMED",
      value: "1",
    });
    expect(result.current.form.envRows[1]).toEqual(row("B", "2"));
  });

  it("patches only the targeted row's value", () => {
    const { result } = renderHook(() =>
      useEnvRowsHarness([row("A", "1"), row("B", "2")]),
    );

    act(() => {
      result.current.api.updateEnvRow(1, { value: "changed" });
    });

    expect(result.current.form.envRows[1]).toEqual({
      rowId: "row-B",
      key: "B",
      value: "changed",
    });
  });

  it("keeps stable callback references across renders", () => {
    const { result, rerender } = renderHook(() => useEnvRowsHarness([]));
    const { handleEnvRowAdd, handleEnvRowRemove, updateEnvRow } =
      result.current.api;

    rerender();

    expect(result.current.api.handleEnvRowAdd).toBe(handleEnvRowAdd);
    expect(result.current.api.handleEnvRowRemove).toBe(handleEnvRowRemove);
    expect(result.current.api.updateEnvRow).toBe(updateEnvRow);
  });
});
