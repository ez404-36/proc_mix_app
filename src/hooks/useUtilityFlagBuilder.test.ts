import { renderHook, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseUtilityFlagsMock = vi.fn<(name: string) => Promise<ParsedCli>>();
vi.mock("../services/utilityHelp", () => ({
  parseUtilityFlags: (name: string) => parseUtilityFlagsMock(name),
}));

import { useUtilityFlagBuilder } from "./useUtilityFlagBuilder";
import type { ParsedCli, UtilityHelp } from "../types";
import type { FormState } from "../types/commandForm";
import type { UtilityNameRange } from "../utils/utilityName";

function parsed(flag: string): ParsedCli {
  return {
    positionalArgs: [],
    flags: [
      {
        flags: [flag],
        takesValue: false,
        valueHint: "",
        description: `desc ${flag}`,
        required: false,
      },
    ],
  };
}

function range(name: string): UtilityNameRange {
  return { name, start: 0, end: name.length };
}

function found(utility: string): UtilityHelp {
  return {
    utility,
    status: "found",
    source: "help",
    text: `Usage: ${utility}`,
    truncated: false,
  };
}

function notFound(utility: string): UtilityHelp {
  return {
    utility,
    status: "not-found",
    source: null,
    text: null,
    truncated: false,
  };
}

function makeForm(script: string): FormState {
  return {
    name: "",
    description: "",
    script,
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
  };
}

interface HarnessProps {
  utilityRanges: ReadonlyArray<UtilityNameRange>;
  helpByUtility: ReadonlyMap<string, UtilityHelp>;
  resolvedHelp: UtilityHelp | null;
  utilityRange: UtilityNameRange | null;
}

function props(p: HarnessProps): HarnessProps {
  return p;
}

function useHarness(p: HarnessProps) {
  const [form, setForm] = useState<FormState>(() => makeForm("df"));
  const api = useUtilityFlagBuilder({ ...p, setForm });
  return { form, api };
}

beforeEach(() => {
  parseUtilityFlagsMock.mockReset();
  parseUtilityFlagsMock.mockImplementation((name) =>
    Promise.resolve(parsed(`--${name}`)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUtilityFlagBuilder", () => {
  it("starts closed with no data and no fetch for an empty script", () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    expect(result.current.api.flagBuilderOpen).toBe(false);
    expect(result.current.api.flagBuilderData).toBeNull();
    expect(result.current.api.flagBuilderLoading).toBe(false);
    expect(result.current.api.flagsByUtility.size).toBe(0);
  });

  it("proactively fetches parsed flags for every found utility", async () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("df"), range("du")],
        helpByUtility: new Map([
          ["df", found("df")],
          ["du", found("du")],
        ]),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    await waitFor(() =>
      expect(result.current.api.flagsByUtility.size).toBe(2),
    );
    expect(result.current.api.flagsByUtility.get("df")).toEqual(parsed("--df"));
    expect(result.current.api.flagsByUtility.get("du")).toEqual(parsed("--du"));
  });

  it("ignores utilities that are not resolved to found", async () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("df"), range("nope")],
        helpByUtility: new Map([
          ["df", found("df")],
          ["nope", notFound("nope")],
        ]),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    await waitFor(() =>
      expect(result.current.api.flagsByUtility.has("df")).toBe(true),
    );
    expect(result.current.api.flagsByUtility.has("nope")).toBe(false);
    expect(parseUtilityFlagsMock).not.toHaveBeenCalledWith("nope");
  });

  it("prunes cached flags for a utility that is no longer found", async () => {
    const { result, rerender } = renderHook(
      (p: HarnessProps) => useHarness(p),
      {
        initialProps: props({
          utilityRanges: [range("df"), range("du")],
          helpByUtility: new Map([
            ["df", found("df")],
            ["du", found("du")],
          ]),
          resolvedHelp: null,
          utilityRange: null,
        }),
      },
    );

    await waitFor(() =>
      expect(result.current.api.flagsByUtility.size).toBe(2),
    );

    // Drop `du` from the found set.
    rerender({
      utilityRanges: [range("df")],
      helpByUtility: new Map([["df", found("df")]]),
      resolvedHelp: null,
      utilityRange: null,
    });

    await waitFor(() =>
      expect(result.current.api.flagsByUtility.has("du")).toBe(false),
    );
    expect(result.current.api.flagsByUtility.has("df")).toBe(true);
  });

  it("clears data and closes the panel when no utility is found", async () => {
    const { result, rerender } = renderHook(
      (p: HarnessProps) => useHarness(p),
      {
        initialProps: props({
          utilityRanges: [range("df")],
          helpByUtility: new Map([["df", found("df")]]),
          resolvedHelp: found("df"),
          utilityRange: range("df"),
        }),
      },
    );

    await act(async () => {
      result.current.api.handleOpenFlagBuilder();
    });
    await waitFor(() => expect(result.current.api.flagBuilderOpen).toBe(true));

    rerender(
      props({
        utilityRanges: [],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    await waitFor(() => {
      expect(result.current.api.flagBuilderOpen).toBe(false);
      expect(result.current.api.flagBuilderData).toBeNull();
    });
  });

  it("opens the builder on demand and toggles loading", async () => {
    let resolveFetch: (v: ParsedCli) => void = () => {};
    parseUtilityFlagsMock.mockImplementation(
      () =>
        new Promise<ParsedCli>((res) => {
          resolveFetch = res;
        }),
    );

    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("tar")],
        // `found` leading help so the leading-sync effect does not close the
        // panel while the on-demand fetch is in flight.
        helpByUtility: new Map([["tar", found("tar")]]),
        resolvedHelp: found("tar"),
        utilityRange: range("tar"),
      }),
    );

    act(() => {
      result.current.api.handleOpenFlagBuilder();
    });
    expect(result.current.api.flagBuilderLoading).toBe(true);

    await act(async () => {
      resolveFetch(parsed("--tar"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.api.flagBuilderLoading).toBe(false);
      expect(result.current.api.flagBuilderOpen).toBe(true);
      expect(result.current.api.flagBuilderData).toEqual(parsed("--tar"));
    });
  });

  it("does nothing on open when there is no leading utility range", () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    act(() => {
      result.current.api.handleOpenFlagBuilder();
    });

    expect(parseUtilityFlagsMock).not.toHaveBeenCalled();
    expect(result.current.api.flagBuilderLoading).toBe(false);
  });

  it("stops loading and stays closed when the on-demand fetch rejects", async () => {
    parseUtilityFlagsMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("tar")],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: range("tar"),
      }),
    );

    await act(async () => {
      result.current.api.handleOpenFlagBuilder();
    });

    await waitFor(() =>
      expect(result.current.api.flagBuilderLoading).toBe(false),
    );
    expect(result.current.api.flagBuilderOpen).toBe(false);
  });

  it("keeps the fetch marker retryable when the proactive fetch rejects", async () => {
    parseUtilityFlagsMock.mockRejectedValueOnce(new Error("transient"));

    const { result, rerender } = renderHook(
      (p: HarnessProps) => useHarness(p),
      {
        initialProps: props({
          utilityRanges: [range("df")],
          helpByUtility: new Map([["df", found("df")]]),
          resolvedHelp: null,
          utilityRange: null,
        }),
      },
    );

    await waitFor(() => expect(parseUtilityFlagsMock).toHaveBeenCalledTimes(1));
    expect(result.current.api.flagsByUtility.has("df")).toBe(false);

    // Force the effect to run again with the same found set by toggling and
    // restoring — the marker was deleted on rejection so it refetches.
    rerender(
      props({
        utilityRanges: [],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );
    rerender(
      props({
        utilityRanges: [range("df")],
        helpByUtility: new Map([["df", found("df")]]),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    await waitFor(() =>
      expect(result.current.api.flagsByUtility.get("df")).toEqual(parsed("--df")),
    );
  });

  it("syncs the panel data to the leading utility's cached flags", async () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("df")],
        helpByUtility: new Map([["df", found("df")]]),
        resolvedHelp: found("df"),
        utilityRange: range("df"),
      }),
    );

    await waitFor(() =>
      expect(result.current.api.flagBuilderData).toEqual(parsed("--df")),
    );
  });

  it("applies a builder-edited script through setForm", () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [],
        helpByUtility: new Map(),
        resolvedHelp: null,
        utilityRange: null,
      }),
    );

    act(() => {
      result.current.api.handleFlagBuilderChange("df -h");
    });

    expect(result.current.form.script).toBe("df -h");
  });

  it("dismisses the panel but keeps the cached data for highlighting", async () => {
    const { result } = renderHook(() =>
      useHarness({
        utilityRanges: [range("df")],
        helpByUtility: new Map([["df", found("df")]]),
        resolvedHelp: found("df"),
        utilityRange: range("df"),
      }),
    );

    await act(async () => {
      result.current.api.handleOpenFlagBuilder();
    });
    await waitFor(() => expect(result.current.api.flagBuilderOpen).toBe(true));

    act(() => {
      result.current.api.handleFlagBuilderDismiss();
    });

    expect(result.current.api.flagBuilderOpen).toBe(false);
    expect(result.current.api.flagBuilderData).toEqual(parsed("--df"));
  });
});
