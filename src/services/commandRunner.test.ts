import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../types";

// Mock the executor module so triggerCommandRun's network/IPC call is
// completely controlled by the test. `awaitBridgeReady` is mocked to resolve
// immediately — the real implementation gates the IPC on the global Tauri
// listener being live, which is irrelevant when invoke itself is mocked.
const invokeRunMock = vi.fn();
const awaitBridgeReadyMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../utils/executor", () => ({
  runCommand: (...args: unknown[]) => invokeRunMock(...args),
  awaitBridgeReady: () => awaitBridgeReadyMock(),
}));

// Mock the admin-password service. We want fine-grained control over
// the prompt resolution and the setAdminPassword side effects so we
// can drive every branch of triggerCommandRun's sentinel-retry loop.
const promptForAdminPasswordMock = vi.fn();
const setAdminPasswordMock = vi.fn();
vi.mock("../utils/adminPassword", async (importOriginal) => {
  // Re-export the real constants/detector so sentinel comparison
  // matches what production code does. Only the side-effectful
  // setAdminPassword is stubbed.
  const actual = await importOriginal<typeof import("../utils/adminPassword")>();
  return {
    ...actual,
    setAdminPassword: (...args: unknown[]) => setAdminPasswordMock(...args),
  };
});
vi.mock("../utils/adminPasswordPrompt", () => ({
  promptForAdminPassword: () => promptForAdminPasswordMock(),
}));

// Mock the variable-prompt singleton. The real implementation
// short-circuits on empty specs, so the existing happy-path tests don't
// care about this mock — they just need it to exist and not throw.
// The prompt-flow tests further down REPLACE this mock per test via
// promptForVariablesMock.mockResolvedValueOnce.
const promptForVariablesMock = vi.fn().mockResolvedValue({});
vi.mock("../utils/variablePrompt", () => ({
  promptForVariables: (...args: unknown[]) => promptForVariablesMock(...args),
}));

// Mock Arco's Message so we can assert error/warning UX without
// rendering Arco.
const messageErrorMock = vi.fn();
const messageWarningMock = vi.fn();
vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: (...args: unknown[]) => messageErrorMock(...args),
    warning: (...args: unknown[]) => messageWarningMock(...args),
  },
}));

// Mock the Tauri IPC modules used transitively by the stores' imports.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { triggerCommandRun } from "./commandRunner";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-99",
    name: "My Command",
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

/**
 * The execution id is now generated CLIENT-side and forwarded to the
 * executor (so the store + history row are registered before the process
 * can finish — closing the fast-command race). Read the id `triggerCommandRun`
 * actually used from the `executionId` it passed to `invokeRun` on the Nth
 * call (0-indexed). This is the same id it returns and registers in the store.
 */
function usedExecutionId(callIndex = 0): string {
  const call = invokeRunMock.mock.calls[callIndex];
  const opts = (call?.[1] ?? {}) as { executionId?: string };
  if (typeof opts.executionId !== "string") {
    throw new Error("invokeRun was not called with an executionId");
  }
  return opts.executionId;
}

beforeEach(() => {
  invokeRunMock.mockReset();
  messageErrorMock.mockReset();
  messageWarningMock.mockReset();
  promptForAdminPasswordMock.mockReset();
  setAdminPasswordMock.mockReset();
  promptForVariablesMock.mockReset();
  // Default: no specs need prompting → resolveVariableValues returns {}
  // without calling the mock. The prompt-flow tests below override
  // this per-test via mockResolvedValueOnce.
  promptForVariablesMock.mockResolvedValue({});
  // Reset execution store between tests for isolation.
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
});

describe("triggerCommandRun", () => {
  it("should return the client-generated execution id and register it in the execution store", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand();

    const result = await triggerCommandRun(cmd);

    // The id is generated client-side and forwarded to the executor; it is
    // returned and registered in the store (the IPC return value is ignored).
    const id = usedExecutionId();
    expect(result).toBe(id);
    // `attempt` always provides `variableValues` and now pins the
    // `executionId` it pre-registered.
    expect(invokeRunMock).toHaveBeenCalledWith(cmd, {
      variableValues: {},
      executionId: id,
    });
    const exec = useExecutionStore.getState().executions[id];
    expect(exec).toBeDefined();
    expect(exec?.commandId).toBe("cmd-99");
    expect(exec?.commandName).toBe("My Command");
    expect(useExecutionStore.getState().activeExecutionId).toBe(id);
    expect(useExecutionStore.getState().panelOpen).toBe(true);
  });

  it("should pass RunOptions through to the executor", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand();
    const opts = {
      workingDir: "/x",
      envOverride: { A: "B" },
      variableValues: {},
    };

    await triggerCommandRun(cmd, opts);

    // `attempt` ensures variableValues is always present and pins the
    // client-generated executionId. We assert on the merged shape.
    expect(invokeRunMock).toHaveBeenCalledWith(cmd, {
      ...opts,
      variableValues: {},
      executionId: usedExecutionId(),
    });
  });

  it("should increment the command runCount when the run succeeds", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    // Seed a command in the store so markCommandRun has something to update.
    const seed = makeCommand({ id: "seed-1", runCount: 5 });
    useCommandStore.setState((s) => ({ commands: [...s.commands, seed] }));

    await triggerCommandRun(seed);

    const stored = useCommandStore
      .getState()
      .commands.find((c) => c.id === "seed-1");
    expect(stored?.runCount).toBe(6);
    expect(stored?.lastRunAt).toBeTypeOf("string");
  });

  it("should return null and show an Error-derived message when the executor rejects with an Error", async () => {
    invokeRunMock.mockRejectedValueOnce(new Error("boom"));
    const cmd = makeCommand({ name: "Broken" });

    const result = await triggerCommandRun(cmd);

    expect(result).toBeNull();
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    expect(messageErrorMock).toHaveBeenCalledWith(
      'Failed to run "Broken": boom',
    );
    // The run is pre-registered before the invoke (to close the fast-command
    // history race), so a launch failure finalizes that execution as
    // `cancelled` rather than leaving the store empty.
    const id = usedExecutionId();
    expect(useExecutionStore.getState().executions[id]?.status).toBe(
      "cancelled",
    );
  });

  it("should stringify non-Error rejections in the error message", async () => {
    invokeRunMock.mockRejectedValueOnce("plain string failure");
    const cmd = makeCommand({ name: "Plain" });

    const result = await triggerCommandRun(cmd);

    expect(result).toBeNull();
    expect(messageErrorMock).toHaveBeenCalledWith(
      'Failed to run "Plain": plain string failure',
    );
  });

  it("finalizes the pre-registered execution as cancelled on launch failure", async () => {
    invokeRunMock.mockRejectedValueOnce(new Error("nope"));
    await triggerCommandRun(makeCommand());
    const id = usedExecutionId();
    // Pre-registration opens the panel and registers the execution; a launch
    // failure must finalize it (not leave it stuck "running") — so it ends as
    // a terminal `cancelled`, never an eternal spinner.
    expect(useExecutionStore.getState().executions[id]?.status).toBe(
      "cancelled",
    );
    expect(useExecutionStore.getState().executions[id]?.finishedAt).toBeTypeOf(
      "number",
    );
  });
});

describe("triggerCommandRun — admin-password sentinel flow", () => {
  // Happy path: first attempt yields the sentinel, modal returns a
  // password, setAdminPassword succeeds, the retry succeeds. The user
  // should NEVER see a toast — the prompt IS the UX, not the error.
  it("prompts, persists, and retries the run when the first attempt yields the sentinel", async () => {
    invokeRunMock
      .mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED")
      .mockResolvedValueOnce(undefined);
    promptForAdminPasswordMock.mockResolvedValueOnce({
      password: "hunter2",
      remember: true,
    });
    setAdminPasswordMock.mockResolvedValueOnce(undefined);

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true, name: "Need Admin" }),
    );

    // The retry reuses the SAME client-generated id (no second insert), so
    // both invokeRun calls carry it and it is the returned value.
    const id = usedExecutionId();
    expect(usedExecutionId(1)).toBe(id);
    expect(result).toBe(id);
    expect(invokeRunMock).toHaveBeenCalledTimes(2);
    expect(promptForAdminPasswordMock).toHaveBeenCalledTimes(1);
    expect(setAdminPasswordMock).toHaveBeenCalledWith("hunter2");
    // Persistence flow must NOT attach the password to the retry's
    // RunOptions — the executor is expected to read it from the
    // keychain. Leaking it via the IPC payload would defeat the
    // whole point of having two flows.
    const retryCall = invokeRunMock.mock.calls[1];
    const retryOpts = (retryCall?.[1] ?? undefined) as
      | { adminPassword?: string }
      | undefined;
    expect(retryOpts?.adminPassword).toBeUndefined();
    expect(messageErrorMock).not.toHaveBeenCalled();
    const exec = useExecutionStore.getState().executions[id];
    expect(exec).toBeDefined();
  });

  // One-shot path: user clicked "Continue" (remember=false). We MUST
  // skip setAdminPassword entirely (otherwise the keychain ends up
  // holding a value the user explicitly didn't want to save) and pass
  // the password through RunOptions so the Rust executor uses it
  // without ever reading from the keychain.
  it("forwards the password via RunOptions without persisting when remember=false", async () => {
    invokeRunMock
      .mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED")
      .mockResolvedValueOnce(undefined);
    promptForAdminPasswordMock.mockResolvedValueOnce({
      password: "ephemeral",
      remember: false,
    });

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true, name: "Need Admin" }),
    );

    expect(result).toBe(usedExecutionId());
    expect(invokeRunMock).toHaveBeenCalledTimes(2);
    expect(setAdminPasswordMock).not.toHaveBeenCalled();
    // Second invokeRun must carry the password in RunOptions; first
    // call (the initial attempt that yielded the sentinel) must not.
    const firstOpts = (invokeRunMock.mock.calls[0]?.[1] ?? undefined) as
      | { adminPassword?: string }
      | undefined;
    const retryOpts = (invokeRunMock.mock.calls[1]?.[1] ?? undefined) as
      | { adminPassword?: string }
      | undefined;
    expect(firstOpts?.adminPassword).toBeUndefined();
    expect(retryOpts?.adminPassword).toBe("ephemeral");
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  // Cancellation path: user closes the modal. We must NOT call
  // setAdminPassword (would corrupt the keychain with a stray value)
  // and we must NOT retry the run (which would just hit the sentinel
  // again). Silent return — the user cancelled deliberately.
  it("returns null without retrying when the user cancels the prompt", async () => {
    invokeRunMock.mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED");
    promptForAdminPasswordMock.mockResolvedValueOnce(null);

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true }),
    );

    expect(result).toBeNull();
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    expect(setAdminPasswordMock).not.toHaveBeenCalled();
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  // Wrong-password path: sudo rejects the saved password on the retry,
  // so we get the sentinel TWICE in a row. We must show a localised
  // "wrong password" toast and stop — never recurse into a third
  // attempt that would hit the same wall.
  it("stops after exactly one retry when the sentinel repeats", async () => {
    invokeRunMock
      .mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED")
      .mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED");
    promptForAdminPasswordMock.mockResolvedValueOnce({
      password: "wrong-password",
      remember: true,
    });
    setAdminPasswordMock.mockResolvedValueOnce(undefined);

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true }),
    );

    expect(result).toBeNull();
    expect(invokeRunMock).toHaveBeenCalledTimes(2);
    expect(promptForAdminPasswordMock).toHaveBeenCalledTimes(1);
    // Exactly one error toast — the localized "wrong password" one.
    // Production uses i18n.t with a default value, so the actual
    // message ends up being the default English string.
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    const msg = messageErrorMock.mock.calls[0]?.[0] as string;
    expect(msg.toLowerCase()).toContain("password");
  });

  // setAdminPassword failure: keychain unavailable mid-flight. The
  // retry must NOT proceed (would just hit the sentinel forever), and
  // the user must see a toast that mentions the underlying error so
  // they can fix it (e.g. unlock the keyring, fix D-Bus).
  it("surfaces a save error and stops when persisting the password fails", async () => {
    invokeRunMock.mockRejectedValueOnce("ADMIN_PASSWORD_REQUIRED");
    promptForAdminPasswordMock.mockResolvedValueOnce({
      password: "hunter2",
      remember: true,
    });
    setAdminPasswordMock.mockRejectedValueOnce(new Error("keychain locked"));

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true }),
    );

    expect(result).toBeNull();
    // Single attempt — no retry after the save failed.
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    const msg = messageErrorMock.mock.calls[0]?.[0] as string;
    expect(msg.toLowerCase()).toContain("keychain locked");
  });

  // Non-sentinel errors must NOT trigger the prompt-retry path. A
  // plain script failure like "command not found" should go straight
  // to the toast — opening the password prompt for an unrelated error
  // would be confusing and would silently consume the user's input.
  it("does not enter the sentinel flow for unrelated errors", async () => {
    invokeRunMock.mockRejectedValueOnce(new Error("bash: foo: command not found"));

    const result = await triggerCommandRun(
      makeCommand({ runAsAdmin: true }),
    );

    expect(result).toBeNull();
    expect(promptForAdminPasswordMock).not.toHaveBeenCalled();
    expect(setAdminPasswordMock).not.toHaveBeenCalled();
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("triggerCommandRun — variable-prompt flow", () => {
  // No default value → must prompt. User cancels → run is aborted,
  // executor MUST NOT be invoked at all. Matches the admin-password
  // cancel semantics: silent return, no toast.
  it("aborts the run when the user cancels the variable prompt", async () => {
    promptForVariablesMock.mockResolvedValueOnce(null);
    const cmd = makeCommand({ variables: [{ name: "x" }] });

    const result = await triggerCommandRun(cmd);

    expect(result).toBeNull();
    expect(invokeRunMock).not.toHaveBeenCalled();
    expect(promptForVariablesMock).toHaveBeenCalledTimes(1);
  });

  // No default value → must prompt. User fills in → executor receives
  // the prompted map as `variableValues`.
  it("forwards the prompt result as variableValues when the user submits", async () => {
    promptForVariablesMock.mockResolvedValueOnce({ x: "world" });
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand({ variables: [{ name: "x" }] });

    const result = await triggerCommandRun(cmd);

    expect(result).toBe(usedExecutionId());
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    const [, runOpts] = invokeRunMock.mock.calls[0] as [
      unknown,
      { variableValues: Record<string, string> },
    ];
    expect(runOpts.variableValues).toEqual({ x: "world" });
  });

  // Empty-string default → the runner MUST NOT prompt. The executor
  // receives `{ x: "" }` because the empty string is a valid default
  // (per VariableSpec docs). This is the regression guard for the
  // most-common mis-implementation of the prompt-or-default decision.
  it("does NOT prompt when every spec has a default (including empty string)", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand({
      variables: [{ name: "x", defaultValue: "" }],
    });

    const result = await triggerCommandRun(cmd);

    expect(result).toBe(usedExecutionId());
    expect(promptForVariablesMock).not.toHaveBeenCalled();
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    const [, runOpts] = invokeRunMock.mock.calls[0] as [
      unknown,
      { variableValues: Record<string, string> },
    ];
    expect(runOpts.variableValues).toEqual({ x: "" });
  });
});

describe("triggerCommandRun — inline-escalation advisory (Class B)", () => {
  it("warns when sudo appears after && on a non-elevated run", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand({
      runAsAdmin: false,
      script: "cd /tmp && sudo apt update",
    });

    const result = await triggerCommandRun(cmd);

    expect(result).toBe(usedExecutionId());
    // The run still proceeds — the advisory is non-blocking.
    expect(invokeRunMock).toHaveBeenCalledTimes(1);
    expect(messageWarningMock).toHaveBeenCalledTimes(1);
  });

  it("warns when sudo is piped into on a non-elevated run", async () => {
    invokeRunMock.mockResolvedValueOnce(undefined);
    const cmd = makeCommand({
      runAsAdmin: false,
      script: "echo y | sudo apt remove foo",
    });

    await triggerCommandRun(cmd);

    expect(messageWarningMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn for a leading sudo (auto-elevated, handled correctly)", async () => {
    invokeRunMock.mockResolvedValueOnce("exec-adv-3");
    const cmd = makeCommand({ runAsAdmin: false, script: "sudo apt update" });

    await triggerCommandRun(cmd);

    expect(messageWarningMock).not.toHaveBeenCalled();
  });

  it("does NOT warn when the run is already elevated", async () => {
    invokeRunMock.mockResolvedValueOnce("exec-adv-4");
    const cmd = makeCommand({
      runAsAdmin: true,
      script: "cd /tmp && sudo apt update",
    });

    await triggerCommandRun(cmd);

    expect(messageWarningMock).not.toHaveBeenCalled();
  });

  it("does NOT warn when opts.elevated overrides to true", async () => {
    invokeRunMock.mockResolvedValueOnce("exec-adv-5");
    const cmd = makeCommand({
      runAsAdmin: false,
      script: "cd /tmp && sudo apt update",
    });

    await triggerCommandRun(cmd, { elevated: true, variableValues: {} });

    expect(messageWarningMock).not.toHaveBeenCalled();
  });

  it("does NOT warn for a script without any escalation tool", async () => {
    invokeRunMock.mockResolvedValueOnce("exec-adv-6");
    const cmd = makeCommand({ runAsAdmin: false, script: "ls -la && rm x" });

    await triggerCommandRun(cmd);

    expect(messageWarningMock).not.toHaveBeenCalled();
  });
});
