import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command, Execution, ExecutionEvent } from "../types";
import type { FormState, RunResult } from "../types/commandForm";
import type { AdminPasswordPromptResult } from "../utils/adminPasswordPrompt";
import type { RunOptions } from "../utils/executor";

const isAdminPasswordRequiredErrorMock = vi.fn<(err: unknown) => boolean>();
const setAdminPasswordMock = vi.fn<(pw: string) => Promise<void>>();
vi.mock("../utils/adminPassword", () => ({
  isAdminPasswordRequiredError: (err: unknown) =>
    isAdminPasswordRequiredErrorMock(err),
  setAdminPassword: (pw: string) => setAdminPasswordMock(pw),
}));

const promptForAdminPasswordMock =
  vi.fn<() => Promise<AdminPasswordPromptResult | null>>();
vi.mock("../utils/adminPasswordPrompt", () => ({
  promptForAdminPassword: () => promptForAdminPasswordMock(),
}));

const cancelExecutionMock = vi.fn<(id: string) => Promise<void>>();
const runCommandMock =
  vi.fn<(cmd: Command, opts: RunOptions) => Promise<string>>();
const subscribeMock = vi.fn();
vi.mock("../utils/executor", () => ({
  cancelExecution: (id: string) => cancelExecutionMock(id),
  runCommand: (cmd: Command, opts: RunOptions) => runCommandMock(cmd, opts),
  subscribeExecutionEvents: (...args: unknown[]) => subscribeMock(...args),
}));

const resolveVariableValuesMock =
  vi.fn<
    (
      cmd: Command,
      caller: Record<string, string>,
    ) => Promise<Record<string, string> | null>
  >();
const triggerCommandRunMock =
  vi.fn<(cmd: Command, opts?: RunOptions) => Promise<string | null>>();
vi.mock("../services/commandRunner", () => ({
  resolveVariableValues: (cmd: Command, caller: Record<string, string>) =>
    resolveVariableValuesMock(cmd, caller),
  triggerCommandRun: (cmd: Command, opts?: RunOptions) =>
    triggerCommandRunMock(cmd, opts),
}));

const messageErrorMock = vi.fn<(content: string) => void>();
vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: (content: string) => messageErrorMock(content),
  },
}));

import { useCommandLiveRun } from "./useCommandLiveRun";
import type {
  UseCommandLiveRunOptions,
  UseCommandLiveRunResult,
} from "./useCommandLiveRun";
import { useExecutionStore } from "../stores/executionStore";
import {
  __resetTransientRegistryForTests,
  isTransient,
} from "../utils/transientExecutions";

type Handler = (e: ExecutionEvent) => void;

const translate = ((key: string, opts?: Record<string, unknown>): string => {
  if (opts && typeof opts.defaultValue === "string") return opts.defaultValue;
  return key;
}) as unknown as UseCommandLiveRunOptions["t"];

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    name: "My Command",
    description: "",
    script: "echo hi",
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

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    name: "Old",
    script: "echo old",
    shell: "bash",
    tags: [],
    favorite: false,
    runAsAdmin: false,
    createdAt: "",
    updatedAt: "",
    runCount: 0,
    ...overrides,
  };
}

interface Harness {
  result: { current: UseCommandLiveRunResult };
  setAdminPasswordStored: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function mountHook(
  form: FormState = makeForm(),
  opts: Partial<UseCommandLiveRunOptions> = {},
): Harness {
  const setAdminPasswordStored = vi.fn();
  const fullOpts: UseCommandLiveRunOptions = {
    command: null,
    runTarget: "embedded",
    setAdminPasswordStored,
    t: translate,
    ...opts,
  };
  const { result, unmount } = renderHook(
    ({ form: f }: { form: FormState }) => useCommandLiveRun(f, fullOpts),
    { initialProps: { form } },
  );
  return { result, setAdminPasswordStored, unmount };
}

function resetExecStore(): void {
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
}

beforeEach(() => {
  isAdminPasswordRequiredErrorMock.mockReset();
  isAdminPasswordRequiredErrorMock.mockReturnValue(false);
  setAdminPasswordMock.mockReset();
  setAdminPasswordMock.mockResolvedValue(undefined);
  promptForAdminPasswordMock.mockReset();
  promptForAdminPasswordMock.mockResolvedValue(null);
  cancelExecutionMock.mockReset();
  cancelExecutionMock.mockResolvedValue(undefined);
  runCommandMock.mockReset();
  runCommandMock.mockResolvedValue("run-id");
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
  resolveVariableValuesMock.mockReset();
  resolveVariableValuesMock.mockResolvedValue({});
  triggerCommandRunMock.mockReset();
  triggerCommandRunMock.mockResolvedValue("global-exec-1");
  messageErrorMock.mockReset();
  __resetTransientRegistryForTests();
  resetExecStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useCommandLiveRun - mounting and return shape", () => {
  it("exposes the initial idle run state and all callbacks", () => {
    const { result } = mountHook();
    expect(result.current.runResult.status).toBe("idle");
    expect(result.current.runResult.lines).toEqual([]);
    expect(result.current.outputCollapsed).toBe(true);
    expect(result.current.globalExecution).toBeUndefined();
    expect(result.current.isGlobalRunning).toBe(false);
    expect(typeof result.current.run).toBe("function");
    expect(typeof result.current.cancel).toBe("function");
    expect(typeof result.current.clear).toBe("function");
    expect(typeof result.current.runGlobal).toBe("function");
    expect(typeof result.current.cancelGlobal).toBe("function");
    expect(typeof result.current.resetRun).toBe("function");
    expect(typeof result.current.cancelActiveRunForSave).toBe("function");
    expect(typeof result.current.teardownRun).toBe("function");
    expect(typeof result.current.closeWithRunGuard).toBe("function");
  });

  it("allows toggling outputCollapsed via the exposed setter", () => {
    const { result } = mountHook();
    act(() => {
      result.current.setOutputCollapsed(false);
    });
    expect(result.current.outputCollapsed).toBe(false);
  });
});

describe("useCommandLiveRun - run early returns", () => {
  it("does nothing when the script is only whitespace", async () => {
    const { result } = mountHook(makeForm({ script: "   " }));
    await act(async () => {
      await result.current.run();
    });
    expect(resolveVariableValuesMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(result.current.runResult.status).toBe("idle");
  });

  it("tears down and returns when variable resolution is cancelled", async () => {
    resolveVariableValuesMock.mockResolvedValue(null);
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(result.current.runResult.status).toBe("idle");
    // Transient mark cleared by teardown.
    expect(isTransient("run-id")).toBe(false);
  });
});

describe("useCommandLiveRun - happy-path run", () => {
  it("marks transient, subscribes, sets running state and invokes the executor", async () => {
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(result.current.runResult.status).toBe("running");
    expect(result.current.outputCollapsed).toBe(false);
    expect(handler).not.toBeNull();
  });

  it("tears down a leftover run before starting a new one", async () => {
    const unsub = vi.fn();
    subscribeMock.mockReturnValue(unsub);
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    await act(async () => {
      await result.current.run();
    });
    // The first run's unsubscribe was invoked during the second run's teardown.
    expect(unsub).toHaveBeenCalled();
  });

  it("carries in-form fields onto the synthetic command", async () => {
    const form = makeForm({
      name: "  Named  ",
      script: "echo ${x}",
      shell: "bash",
      runAsAdmin: true,
      timeoutSeconds: "12",
      outputSchema: { pipeline: [] },
      envRows: [{ rowId: "e", key: "K", value: "V" }],
      workingDir: "  /tmp  ",
      promptWorkingDir: true,
    });
    const { result } = mountHook(form);
    await act(async () => {
      await result.current.run();
    });
    const [cmd, opts] = runCommandMock.mock.calls[0];
    expect(cmd.name).toBe("Named");
    expect(cmd.runAsAdmin).toBe(true);
    expect(cmd.timeoutSeconds).toBe(12);
    expect(cmd.outputSchema).toEqual({ pipeline: [] });
    expect(cmd.env).toEqual({ K: "V" });
    expect(cmd.workingDir).toBe("/tmp");
    expect(cmd.promptWorkingDir).toBe(true);
    expect(opts.elevated).toBe(true);
  });

  it("falls back to 'Form test' name and omits optional keys when unset", async () => {
    const { result } = mountHook(makeForm({ name: "   " }));
    await act(async () => {
      await result.current.run();
    });
    const [cmd] = runCommandMock.mock.calls[0];
    expect(cmd.name).toBe("Form test");
    expect(cmd).not.toHaveProperty("workingDir");
    expect(cmd).not.toHaveProperty("promptWorkingDir");
    expect(cmd).not.toHaveProperty("env");
    expect(cmd).not.toHaveProperty("outputSchema");
  });
});

describe("useCommandLiveRun - event handler", () => {
  async function mountAndRun(
    form: FormState = makeForm(),
  ): Promise<{ result: { current: UseCommandLiveRunResult }; handler: Handler }> {
    let captured: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      captured = h;
      return () => {};
    });
    const { result } = mountHook(form);
    await act(async () => {
      await result.current.run();
    });
    if (!captured) throw new Error("handler not captured");
    return { result, handler: captured };
  }

  it("ignores events for a different execution id", async () => {
    const { result, handler } = await mountAndRun();
    act(() => {
      handler({ kind: "stdout", executionId: "other", line: "nope" });
    });
    expect(result.current.runResult.lines).toEqual([]);
  });

  it("handles a 'started' event by resetting to running and expanding", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({ kind: "started", executionId: id });
    });
    expect(result.current.runResult.status).toBe("running");
    expect(result.current.runResult.lines).toEqual([]);
    expect(result.current.outputCollapsed).toBe(false);
  });

  it("appends stdout and stderr lines", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({ kind: "stdout", executionId: id, line: "out" });
      handler({ kind: "stderr", executionId: id, line: "err" });
    });
    expect(result.current.runResult.lines).toEqual([
      { stream: "stdout", text: "out" },
      { stream: "stderr", text: "err" },
    ]);
  });

  it("marks a zero-exit 'finished' event as finished and tears down", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({
        kind: "finished",
        executionId: id,
        exitCode: 0,
        durationMs: 42,
      });
    });
    expect(result.current.runResult.status).toBe("finished");
    expect(result.current.runResult.exitCode).toBe(0);
    expect(result.current.runResult.durationMs).toBe(42);
    expect(isTransient(id)).toBe(false);
  });

  it("marks a non-zero-exit 'finished' event as failed", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({
        kind: "finished",
        executionId: id,
        exitCode: 3,
        durationMs: 5,
      });
    });
    expect(result.current.runResult.status).toBe("failed");
  });

  it("marks a timed-out 'finished' event as timedOut and injects a line", async () => {
    const { result, handler } = await mountAndRun(
      makeForm({ timeoutSeconds: "7" }),
    );
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({
        kind: "finished",
        executionId: id,
        exitCode: null,
        durationMs: 100,
        timedOut: true,
      });
    });
    expect(result.current.runResult.status).toBe("timedOut");
    expect(result.current.runResult.timedOut).toBe(true);
    const { lines } = result.current.runResult;
    const last = lines[lines.length - 1];
    expect(last.stream).toBe("stderr");
    expect(last.text).toBe("commandForm.output.timedOutLine");
  });

  it("handles an 'error' event as failed with the message appended", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({ kind: "error", executionId: id, message: "kaboom" });
    });
    expect(result.current.runResult.status).toBe("failed");
    const { lines } = result.current.runResult;
    expect(lines[lines.length - 1]).toEqual({
      stream: "stderr",
      text: "kaboom",
    });
  });

  it("handles a 'cancelled' event as cancelled and tears down", async () => {
    const { result, handler } = await mountAndRun();
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler({ kind: "cancelled", executionId: id });
    });
    expect(result.current.runResult.status).toBe("cancelled");
    expect(isTransient(id)).toBe(false);
  });
});

describe("useCommandLiveRun - admin escalation retry", () => {
  it("reports a non-admin failure directly", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("boom"));
    isAdminPasswordRequiredErrorMock.mockReturnValue(false);
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(result.current.runResult.status).toBe("failed"),
    );
    expect(result.current.runResult.lines).toEqual([
      { stream: "stderr", text: "boom" },
    ]);
    expect(promptForAdminPasswordMock).not.toHaveBeenCalled();
  });

  it("reports a non-Error rejection using String() coercion", async () => {
    runCommandMock.mockRejectedValueOnce("plain string error");
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(result.current.runResult.lines).toEqual([
        { stream: "stderr", text: "plain string error" },
      ]),
    );
  });

  it("drops the run quietly when the admin prompt is cancelled", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"));
    isAdminPasswordRequiredErrorMock.mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue(null);
    const { result } = mountHook(makeForm({ runAsAdmin: true }));
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() => expect(promptForAdminPasswordMock).toHaveBeenCalled());
    expect(result.current.runResult.status).toBe("idle");
    expect(setAdminPasswordMock).not.toHaveBeenCalled();
  });

  it("persists a remembered password, updates the hint, and retries", async () => {
    runCommandMock
      .mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"))
      .mockResolvedValueOnce("retry-id");
    isAdminPasswordRequiredErrorMock.mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "s3cret",
      remember: true,
    });
    const { result, setAdminPasswordStored } = mountHook(
      makeForm({ runAsAdmin: true }),
    );
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(runCommandMock).toHaveBeenCalledTimes(2),
    );
    expect(setAdminPasswordMock).toHaveBeenCalledWith("s3cret");
    expect(setAdminPasswordStored).toHaveBeenCalledWith(true);
    // The remembered path forwards no one-shot password on the retry.
    const retryOpts = runCommandMock.mock.calls[1][1];
    expect(retryOpts.adminPassword).toBeUndefined();
  });

  it("surfaces a toast and resets when persisting the password fails", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"));
    isAdminPasswordRequiredErrorMock.mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "s3cret",
      remember: true,
    });
    setAdminPasswordMock.mockRejectedValueOnce(new Error("keychain down"));
    const { result, setAdminPasswordStored } = mountHook(
      makeForm({ runAsAdmin: true }),
    );
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(setAdminPasswordStored).toHaveBeenCalledWith(false),
    );
    expect(messageErrorMock).toHaveBeenCalledWith(
      "Failed to save admin password: keychain down",
    );
    expect(result.current.runResult.status).toBe("idle");
    // No retry after a failed save.
    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });

  it("coerces a non-Error save failure via String()", async () => {
    runCommandMock.mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"));
    isAdminPasswordRequiredErrorMock.mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "s3cret",
      remember: true,
    });
    setAdminPasswordMock.mockRejectedValueOnce("string-save-fail");
    const { result } = mountHook(makeForm({ runAsAdmin: true }));
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(messageErrorMock).toHaveBeenCalledWith(
        "Failed to save admin password: string-save-fail",
      ),
    );
    expect(result.current.runResult.status).toBe("idle");
  });

  it("retries with a one-shot password when remember is false", async () => {
    runCommandMock
      .mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"))
      .mockResolvedValueOnce("retry-id");
    isAdminPasswordRequiredErrorMock.mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "one-shot",
      remember: false,
    });
    const { result } = mountHook(makeForm({ runAsAdmin: true }));
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() => expect(runCommandMock).toHaveBeenCalledTimes(2));
    expect(setAdminPasswordMock).not.toHaveBeenCalled();
    expect(runCommandMock.mock.calls[1][1].adminPassword).toBe("one-shot");
  });

  it("shows a rejected-password toast when the retry raises the sentinel again", async () => {
    runCommandMock
      .mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"))
      .mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"));
    isAdminPasswordRequiredErrorMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "wrong",
      remember: false,
    });
    const { result } = mountHook(makeForm({ runAsAdmin: true }));
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(messageErrorMock).toHaveBeenCalledWith(
        "Wrong administrator password — please try again",
      ),
    );
    expect(result.current.runResult.status).toBe("idle");
  });

  it("reports a non-sentinel retry failure via reportFailure", async () => {
    runCommandMock
      .mockRejectedValueOnce(new Error("ADMIN_PASSWORD_REQUIRED"))
      .mockRejectedValueOnce(new Error("retry boom"));
    isAdminPasswordRequiredErrorMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    promptForAdminPasswordMock.mockResolvedValue({
      password: "x",
      remember: false,
    });
    const { result } = mountHook(makeForm({ runAsAdmin: true }));
    await act(async () => {
      await result.current.run();
    });
    await waitFor(() =>
      expect(result.current.runResult.status).toBe("failed"),
    );
    expect(result.current.runResult.lines).toEqual([
      { stream: "stderr", text: "retry boom" },
    ]);
  });
});

describe("useCommandLiveRun - cancel", () => {
  it("is a no-op when no run is in flight", () => {
    const { result } = mountHook();
    act(() => {
      result.current.cancel();
    });
    expect(cancelExecutionMock).not.toHaveBeenCalled();
  });

  it("calls cancelExecution for the in-flight run", async () => {
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    act(() => {
      result.current.cancel();
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
  });

  it("logs when cancelExecution rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelExecutionMock.mockRejectedValueOnce(new Error("no proc"));
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    act(() => {
      result.current.cancel();
    });
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to cancel transient execution:",
        expect.any(Error),
      ),
    );
  });

  it("force-transitions to cancelled via the fallback timer when still running", async () => {
    vi.useFakeTimers();
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.runResult.status).toBe("cancelled");
    expect(isTransient(id)).toBe(false);
  });

  it("does not override a terminal state when the fallback timer fires late", async () => {
    vi.useFakeTimers();
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    act(() => {
      result.current.cancel();
    });
    // The executor's terminal event lands before the fallback fires.
    act(() => {
      handler?.({
        kind: "finished",
        executionId: id,
        exitCode: 0,
        durationMs: 1,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.runResult.status).toBe("finished");
  });

  it("clears an existing fallback timer when cancel is invoked twice", async () => {
    vi.useFakeTimers();
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    act(() => {
      result.current.cancel();
      result.current.cancel();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.runResult.status).toBe("cancelled");
    expect(cancelExecutionMock).toHaveBeenCalledTimes(2);
  });
});

describe("useCommandLiveRun - clear", () => {
  it("resets to the initial result when idle", async () => {
    const { result } = mountHook();
    act(() => {
      result.current.clear();
    });
    expect(result.current.runResult).toEqual<RunResult>({
      status: "idle",
      lines: [],
      exitCode: null,
      durationMs: null,
      timedOut: false,
    });
  });

  it("keeps status running but clears lines when a run is in flight", async () => {
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
      handler?.({ kind: "stdout", executionId: id, line: "x" });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.runResult.status).toBe("running");
    expect(result.current.runResult.lines).toEqual([]);
  });
});

describe("useCommandLiveRun - resetRun", () => {
  it("resets run state and recollapses the panel", async () => {
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    act(() => {
      result.current.resetRun();
    });
    expect(result.current.runResult.status).toBe("idle");
    expect(result.current.outputCollapsed).toBe(true);
  });
});

describe("useCommandLiveRun - teardownRun idempotency", () => {
  it("is safe to call with no active run", () => {
    const { result } = mountHook();
    expect(() => {
      act(() => {
        result.current.teardownRun();
      });
    }).not.toThrow();
  });
});

describe("useCommandLiveRun - global run target", () => {
  it("does nothing when the script is whitespace", async () => {
    const { result } = mountHook(makeForm({ script: "  " }), {
      runTarget: "global",
    });
    await act(async () => {
      await result.current.runGlobal();
    });
    expect(triggerCommandRunMock).not.toHaveBeenCalled();
  });

  it("uses the edited command id and tracks the returned execution", async () => {
    triggerCommandRunMock.mockResolvedValue("global-1");
    const command = makeCommand({ id: "cmd-42" });
    const { result } = mountHook(
      makeForm({
        name: " Global ",
        description: " desc ",
        workingDir: " /work ",
        promptWorkingDir: true,
        envRows: [{ rowId: "e", key: "A", value: "B" }],
        outputSchema: { pipeline: [] },
        runAsAdmin: true,
      }),
      { runTarget: "global", command },
    );
    await act(async () => {
      await result.current.runGlobal();
    });
    const [cmd, opts] = triggerCommandRunMock.mock.calls[0];
    expect(cmd.id).toBe("cmd-42");
    expect(cmd.name).toBe("Global");
    expect(cmd.description).toBe("desc");
    expect(cmd.workingDir).toBe("/work");
    expect(cmd.promptWorkingDir).toBe(true);
    expect(cmd.env).toEqual({ A: "B" });
    expect(cmd.outputSchema).toEqual({ pipeline: [] });
    expect(opts?.elevated).toBe(true);
  });

  it("synthesises a draft id, default title and omits empties in create mode", async () => {
    const { result } = mountHook(
      makeForm({ name: "  ", description: "  " }),
      { runTarget: "global", command: null },
    );
    await act(async () => {
      await result.current.runGlobal();
    });
    const [cmd] = triggerCommandRunMock.mock.calls[0];
    expect(cmd.id.startsWith("draft-")).toBe(true);
    expect(cmd.name).toBe("commandForm.title.create");
    expect(cmd.description).toBeUndefined();
    expect(cmd).not.toHaveProperty("workingDir");
    expect(cmd).not.toHaveProperty("promptWorkingDir");
    expect(cmd).not.toHaveProperty("env");
  });

  it("does not track a run when triggerCommandRun returns null", async () => {
    triggerCommandRunMock.mockResolvedValue(null);
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    await act(async () => {
      await result.current.runGlobal();
    });
    expect(result.current.globalExecution).toBeUndefined();
    expect(result.current.isGlobalRunning).toBe(false);
  });

  it("reflects live status from the execution store for a tracked run", async () => {
    triggerCommandRunMock.mockResolvedValue("global-run");
    const exec: Execution = {
      id: "global-run",
      commandName: "Global",
      status: "running",
      startedAt: Date.now(),
      log: [],
    };
    useExecutionStore.setState((s) => ({
      executions: { ...s.executions, "global-run": exec },
    }));
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    await act(async () => {
      await result.current.runGlobal();
    });
    await waitFor(() =>
      expect(result.current.globalExecution?.id).toBe("global-run"),
    );
    expect(result.current.isGlobalRunning).toBe(true);
  });

  it("treats a pending tracked run as running", async () => {
    triggerCommandRunMock.mockResolvedValue("global-pending");
    const exec: Execution = {
      id: "global-pending",
      commandName: "G",
      status: "pending",
      startedAt: Date.now(),
      log: [],
    };
    useExecutionStore.setState((s) => ({
      executions: { ...s.executions, "global-pending": exec },
    }));
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    await act(async () => {
      await result.current.runGlobal();
    });
    await waitFor(() =>
      expect(result.current.isGlobalRunning).toBe(true),
    );
  });
});

describe("useCommandLiveRun - cancelGlobal", () => {
  it("is a no-op when no global run is tracked", () => {
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    act(() => {
      result.current.cancelGlobal();
    });
    expect(cancelExecutionMock).not.toHaveBeenCalled();
  });

  it("cancels the tracked global run", async () => {
    triggerCommandRunMock.mockResolvedValue("global-cancel");
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    await act(async () => {
      await result.current.runGlobal();
    });
    act(() => {
      result.current.cancelGlobal();
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith("global-cancel");
  });

  it("logs when cancelling the global run rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelExecutionMock.mockRejectedValueOnce(new Error("no global"));
    triggerCommandRunMock.mockResolvedValue("global-cancel-2");
    const { result } = mountHook(makeForm(), { runTarget: "global" });
    await act(async () => {
      await result.current.runGlobal();
    });
    act(() => {
      result.current.cancelGlobal();
    });
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to cancel execution:",
        expect.any(Error),
      ),
    );
  });
});

describe("useCommandLiveRun - cancelActiveRunForSave", () => {
  it("does nothing when no run is active", () => {
    const { result } = mountHook();
    act(() => {
      result.current.cancelActiveRunForSave();
    });
    expect(cancelExecutionMock).not.toHaveBeenCalled();
  });

  it("cancels an active running embedded run", async () => {
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    act(() => {
      result.current.cancelActiveRunForSave();
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
  });

  it("swallows a rejection from the best-effort cancel", async () => {
    cancelExecutionMock.mockRejectedValueOnce(new Error("ignored"));
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    await act(async () => {
      result.current.cancelActiveRunForSave();
      await Promise.resolve();
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
  });
});

describe("useCommandLiveRun - closeWithRunGuard", () => {
  it("tears down and closes immediately when no run is active", () => {
    const { result } = mountHook();
    const onClose = vi.fn();
    act(() => {
      result.current.closeWithRunGuard(onClose);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelExecutionMock).not.toHaveBeenCalled();
  });

  it("cancels, waits the grace window, then tears down and closes", async () => {
    vi.useFakeTimers();
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    const onClose = vi.fn();
    act(() => {
      result.current.closeWithRunGuard(onClose);
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isTransient(id)).toBe(false);
  });

  it("logs when the cancel-on-close rejects", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelExecutionMock.mockRejectedValueOnce(new Error("close fail"));
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    await act(async () => {
      result.current.closeWithRunGuard(vi.fn());
      await Promise.resolve();
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to cancel transient execution on close:",
      expect.any(Error),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  });
});

describe("useCommandLiveRun - unmount cleanup", () => {
  it("cancels the in-flight run and tears down on unmount", async () => {
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result, unmount } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    unmount();
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
    expect(isTransient(id)).toBe(false);
  });

  it("swallows a rejected cancel on unmount", async () => {
    cancelExecutionMock.mockRejectedValueOnce(new Error("unmount fail"));
    let handler: Handler | null = null;
    subscribeMock.mockImplementation((h: Handler) => {
      handler = h;
      return () => {};
    });
    const { result, unmount } = mountHook();
    await act(async () => {
      await result.current.run();
    });
    const id = runCommandMock.mock.calls[0][1].executionId as string;
    act(() => {
      handler?.({ kind: "started", executionId: id });
    });
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(cancelExecutionMock).toHaveBeenCalledWith(id);
  });

  it("does not cancel on unmount when no run is active", () => {
    const { unmount } = mountHook();
    unmount();
    expect(cancelExecutionMock).not.toHaveBeenCalled();
  });
});
