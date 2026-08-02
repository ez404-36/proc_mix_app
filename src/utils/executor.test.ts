import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, ExecutionEvent } from "../types";

// The executor module subscribes to "execution-event" at module load via a
// top-level `void ensureSubscribed()` call. To make `listen` observable from
// the test, we must hoist the mock function alongside the vi.mock factory —
// otherwise vi.mock runs before the local `const` is initialized and crashes
// with "Cannot access 'listenMock' before initialization".
// Hoisted before module imports run, so the executor's module-level
// `void ensureSubscribed()` call sees the mocks. The default listen
// implementation resolves to a no-op unlisten so the bootstrap subscribe does
// not reject. We type the mocks via the parameter signature so .mockReset and
// .mockImplementation stay strongly typed downstream.
const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => unknown>(),
  listenMock: vi.fn<(...args: unknown[]) => Promise<() => void>>(() =>
    Promise.resolve(() => {}),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  awaitBridgeReady,
  cancelExecution,
  listRunningExecutions,
  runCommand,
  subscribeExecutionEvents,
} from "./executor";

// The executor module subscribes to "execution-event" at module load. We
// capture the listener Tauri received here so individual tests can simulate
// inbound events without needing to reach back into the mock.
type TauriListener = (e: { payload: ExecutionEvent }) => void;
const moduleLoadListenCalls = listenMock.mock.calls;
const moduleLoadListener: TauriListener | null =
  (moduleLoadListenCalls[0]?.[1] as TauriListener | undefined) ?? null;

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    name: "Test command",
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  // NOTE: do NOT reset listenMock. The executor subscribes at module load via
  // a singleton Promise; resetting the mock would not unwire the real handler
  // already registered in `executor.ts`. We only inspect listenMock.mock.calls
  // from module-load time (captured above).
});

describe("runCommand", () => {
  it("should invoke 'execute_command' with the request payload built from the command", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-1");
    const cmd = makeCommand({
      script: "ls",
      shell: "bash",
      args: ["-la"],
      workingDir: "/tmp",
      env: { FOO: "bar" },
    });

    const id = await runCommand(cmd, { variableValues: {} });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("execute_command", {
      req: {
        script: "ls",
        shell: "bash",
        args: ["-la"],
        workingDir: "/tmp",
        env: { FOO: "bar" },
        commandId: "cmd-1",
        // No client-supplied id for a normal run; Rust generates one.
        executionId: undefined,
      },
    });
    expect(id).toBe("exec-id-1");
  });

  it("should forward opts.executionId to Rust so transient runs can pre-register state", async () => {
    invokeMock.mockResolvedValueOnce("client-uuid-7");
    const cmd = makeCommand();

    await runCommand(cmd, { executionId: "client-uuid-7", variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { executionId?: string } },
    ];
    expect(payload.req.executionId).toBe("client-uuid-7");
  });

  it("should leave env undefined when neither cmd.env nor envOverride is provided", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-2");
    const cmd = makeCommand();

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { env?: Record<string, string> } },
    ];
    expect(payload.req.env).toBeUndefined();
  });

  it("should merge cmd.env with envOverride, with the override taking precedence", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-3");
    const cmd = makeCommand({ env: { FOO: "from-cmd", BAR: "1" } });

    await runCommand(cmd, {
      envOverride: { FOO: "from-override", BAZ: "2" },
      variableValues: {},
    });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { env?: Record<string, string> } },
    ];
    expect(payload.req.env).toEqual({
      FOO: "from-override",
      BAR: "1",
      BAZ: "2",
    });
  });

  it("should include env when only override is provided (no cmd.env)", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-4");
    const cmd = makeCommand();

    await runCommand(cmd, {
      envOverride: { ONLY: "yes" },
      variableValues: {},
    });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { env?: Record<string, string> } },
    ];
    expect(payload.req.env).toEqual({ ONLY: "yes" });
  });

  it("should include env when only cmd.env is provided (no override)", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-5");
    const cmd = makeCommand({ env: { CMDENV: "yes" } });

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { env?: Record<string, string> } },
    ];
    expect(payload.req.env).toEqual({ CMDENV: "yes" });
  });

  it("should prefer opts.workingDir over cmd.workingDir", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-6");
    const cmd = makeCommand({ workingDir: "/cmd-dir" });

    await runCommand(cmd, { workingDir: "/opts-dir", variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { workingDir?: string } },
    ];
    expect(payload.req.workingDir).toBe("/opts-dir");
  });

  it("should fall back to cmd.workingDir when opts.workingDir is omitted", async () => {
    invokeMock.mockResolvedValueOnce("exec-id-7");
    const cmd = makeCommand({ workingDir: "/cmd-dir" });

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { workingDir?: string } },
    ];
    expect(payload.req.workingDir).toBe("/cmd-dir");
  });

  it("includes sshPassword in the payload for a remote run with a password", async () => {
    invokeMock.mockResolvedValueOnce("exec-ssh-1");
    const cmd = makeCommand({ target: { kind: "remote", alias: "prod" } });

    await runCommand(cmd, {
      variableValues: {},
      sshPassword: "hunter2",
    });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { sshPassword?: string; target?: { kind: string } } },
    ];
    expect(payload.req.sshPassword).toBe("hunter2");
    expect(payload.req.target).toEqual({ kind: "remote", alias: "prod" });
  });

  it("omits sshPassword for a local run even if one is passed", async () => {
    invokeMock.mockResolvedValueOnce("exec-ssh-2");
    const cmd = makeCommand(); // local

    await runCommand(cmd, {
      variableValues: {},
      sshPassword: "hunter2",
    });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("sshPassword" in payload.req).toBe(false);
  });

  it("omits a blank sshPassword for a remote run", async () => {
    invokeMock.mockResolvedValueOnce("exec-ssh-3");
    const cmd = makeCommand({ target: { kind: "remote", alias: "prod" } });

    await runCommand(cmd, {
      variableValues: {},
      sshPassword: "   ",
    });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("sshPassword" in payload.req).toBe(false);
  });

  it("should propagate rejection from invoke", async () => {
    invokeMock.mockRejectedValueOnce(new Error("backend down"));
    await expect(
      runCommand(makeCommand(), { variableValues: {} }),
    ).rejects.toThrow("backend down");
  });

  // The elevated-payload contract: when (and ONLY when) the run should
  // be elevated, the request includes `elevated: true`. Non-elevated
  // runs MUST omit the key entirely so payloads stay byte-identical
  // with what we sent before the feature existed (this is also what
  // the Rust-side serde `#[serde(default)]` test verifies on its end).
  it("should include `elevated: true` in the payload when cmd.runAsAdmin is true", async () => {
    invokeMock.mockResolvedValueOnce("exec-elev-1");
    const cmd = makeCommand({ runAsAdmin: true });

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { elevated?: boolean } },
    ];
    expect(payload.req.elevated).toBe(true);
  });

  it("should omit `elevated` from the payload when cmd.runAsAdmin is false", async () => {
    invokeMock.mockResolvedValueOnce("exec-elev-2");
    const cmd = makeCommand({ runAsAdmin: false });

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("elevated" in payload.req).toBe(false);
  });

  // The per-invocation override (used by CommandForm live-run, where
  // the unsaved checkbox can disagree with the persisted Command).
  it("should let opts.elevated override cmd.runAsAdmin in either direction", async () => {
    invokeMock.mockResolvedValueOnce("exec-elev-3");
    const cmd = makeCommand({ runAsAdmin: false });

    await runCommand(cmd, { elevated: true, variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { elevated?: boolean } },
    ];
    expect(payload.req.elevated).toBe(true);

    invokeMock.mockResolvedValueOnce("exec-elev-4");
    const cmd2 = makeCommand({ runAsAdmin: true });

    await runCommand(cmd2, { elevated: false, variableValues: {} });

    const [, payload2] = invokeMock.mock.calls[1] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("elevated" in payload2.req).toBe(false);
  });

  // Regression: elevation must still trigger for an imported command
  // (runAsAdmin forced false) whose script self-escalates via sudo.
  it("forces `elevated: true` when the script begins with sudo even if runAsAdmin is false", async () => {
    invokeMock.mockResolvedValueOnce("exec-elev-5");
    const cmd = makeCommand({
      runAsAdmin: false,
      script:
        "sudo sh -c 'find / -xdev -type f -size +${size}M -print0 2>/dev/null | xargs -0 ls -lh'",
    });

    await runCommand(cmd, { variableValues: { size: "100" } });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { elevated?: boolean } },
    ];
    expect(payload.req.elevated).toBe(true);
  });

  it("honours an explicit opts.elevated=false even when the script begins with sudo", async () => {
    invokeMock.mockResolvedValueOnce("exec-elev-6");
    const cmd = makeCommand({ runAsAdmin: false, script: "sudo apt update" });

    await runCommand(cmd, { elevated: false, variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("elevated" in payload.req).toBe(false);
  });

  // The output-schema contract: forward `cmd.outputSchema` verbatim so the
  // executor runs extraction and emits a `result` event. Omit the key when
  // the command has no schema so the wire stays byte-identical for commands
  // without output parsing.
  it("should forward cmd.outputSchema in the payload when present", async () => {
    invokeMock.mockResolvedValueOnce("exec-schema-1");
    const cmd = makeCommand({
      outputSchema: {
        pipeline: [{ parser: "keyValue", delimiter: "=", fields: [] }],
        returnField: "version",
      },
    });

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: { outputSchema?: unknown } },
    ];
    expect(payload.req.outputSchema).toEqual({
      pipeline: [{ parser: "keyValue", delimiter: "=", fields: [] }],
      returnField: "version",
    });
  });

  it("should omit outputSchema from the payload when the command has none", async () => {
    invokeMock.mockResolvedValueOnce("exec-schema-2");
    const cmd = makeCommand();

    await runCommand(cmd, { variableValues: {} });

    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { req: Record<string, unknown> },
    ];
    expect("outputSchema" in payload.req).toBe(false);
  });
});

describe("cancelExecution", () => {
  it("should invoke 'cancel_execution' with the given execution id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await cancelExecution("exec-42");
    expect(invokeMock).toHaveBeenCalledWith("cancel_execution", {
      executionId: "exec-42",
    });
  });

  it("should resolve to undefined regardless of invoke return value", async () => {
    invokeMock.mockResolvedValueOnce("ignored");
    await expect(cancelExecution("exec-42")).resolves.toBeUndefined();
  });
});

describe("listRunningExecutions", () => {
  it("should invoke 'list_running_executions' and return the resulting array", async () => {
    invokeMock.mockResolvedValueOnce(["a", "b", "c"]);
    const result = await listRunningExecutions();
    expect(invokeMock).toHaveBeenCalledWith("list_running_executions");
    expect(result).toEqual(["a", "b", "c"]);
  });
});

describe("subscribeExecutionEvents (module-level fan-out)", () => {
  it("should have called listen('execution-event', …) exactly once at module load", () => {
    // The executor module's top-level `void ensureSubscribed()` is what fixes
    // the original race: by the time any test or user code runs, the Tauri
    // listener is already registered. Subsequent subscribers attach handlers
    // to a shared in-memory Set rather than calling listen() again.
    expect(moduleLoadListenCalls.length).toBe(1);
    expect(moduleLoadListenCalls[0]?.[0]).toBe("execution-event");
    expect(moduleLoadListener).not.toBeNull();
  });

  it("should fan out a delivered event to every registered handler with only the payload", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = subscribeExecutionEvents(handlerA);
    const unsubB = subscribeExecutionEvents(handlerB);

    const payload: ExecutionEvent = {
      kind: "stdout",
      executionId: "x",
      line: "hello",
    };
    moduleLoadListener?.({ payload });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerA).toHaveBeenCalledWith(payload);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(payload);

    // Clean up so handlers from this test don't leak into later tests.
    unsubA();
    unsubB();
  });

  it("should stop forwarding events to a handler after its unsubscribe is called", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeExecutionEvents(handler);
    unsubscribe();

    moduleLoadListener?.({
      payload: { kind: "stdout", executionId: "y", line: "ignored" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("awaitBridgeReady should resolve once the module-level listen Promise settles", async () => {
    // No throw means resolved — and any test that ran before this one has
    // already observed the listener being live, so this is mostly a smoke test
    // for the public API surface.
    await expect(awaitBridgeReady()).resolves.toBeUndefined();
  });
});
