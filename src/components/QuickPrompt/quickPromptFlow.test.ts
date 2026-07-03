import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  promptForVariables: vi.fn(),
  promptForAdminPassword: vi.fn(),
  setAdminPassword: vi.fn(),
  submitQuickPrompt: vi.fn(),
  cancelQuickPrompt: vi.fn(),
}));

vi.mock("../../utils/variablePrompt", () => ({
  promptForVariables: mocks.promptForVariables,
}));
vi.mock("../../utils/adminPasswordPrompt", () => ({
  promptForAdminPassword: mocks.promptForAdminPassword,
}));
vi.mock("../../utils/adminPassword", () => ({
  setAdminPassword: mocks.setAdminPassword,
}));
vi.mock("../../services/quickPromptService", () => ({
  submitQuickPrompt: mocks.submitQuickPrompt,
  cancelQuickPrompt: mocks.cancelQuickPrompt,
}));

import {
  resolveQuickPromptVariables,
  runQuickPromptFlow,
} from "./quickPromptFlow";
import type { VariableSpec } from "../../types/command";
import type { QuickPromptRequest } from "../../types/quickPrompt";

function baseRequest(over: Partial<QuickPromptRequest> = {}): QuickPromptRequest {
  return {
    commandId: "c1",
    commandName: "Build",
    variables: [],
    needsAdmin: false,
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.submitQuickPrompt.mockResolvedValue(undefined);
  mocks.cancelQuickPrompt.mockResolvedValue(undefined);
  mocks.setAdminPassword.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("resolveQuickPromptVariables", () => {
  it("returns defaults without prompting when every spec has one", async () => {
    const specs: VariableSpec[] = [
      { name: "host", defaultValue: "localhost" },
      { name: "port", defaultValue: "8080" },
    ];
    const values = await resolveQuickPromptVariables(specs, {});
    expect(values).toEqual({ host: "localhost", port: "8080" });
    expect(mocks.promptForVariables).not.toHaveBeenCalled();
  });

  it("prompts only for required specs and merges the result", async () => {
    const specs: VariableSpec[] = [
      { name: "host", defaultValue: "localhost" },
      { name: "target" }, // required, no default
    ];
    mocks.promptForVariables.mockResolvedValue({ target: "/x" });
    const values = await resolveQuickPromptVariables(specs, {});
    expect(values).toEqual({ host: "localhost", target: "/x" });
    // Only the required spec was asked.
    const askedSpecs = mocks.promptForVariables.mock.calls[0]?.[0] as VariableSpec[];
    expect(askedSpecs.map((s) => s.name)).toEqual(["target"]);
  });

  it("a provided value satisfies a required spec without prompting", async () => {
    const specs: VariableSpec[] = [{ name: "PROCMIX_SELECTED_PATH" }];
    const values = await resolveQuickPromptVariables(specs, {
      PROCMIX_SELECTED_PATH: "/home/user/file.txt",
    });
    expect(values).toEqual({ PROCMIX_SELECTED_PATH: "/home/user/file.txt" });
    expect(mocks.promptForVariables).not.toHaveBeenCalled();
  });

  it("prompts a defaulted spec when promptAtRuntime is set", async () => {
    const specs: VariableSpec[] = [
      { name: "env", defaultValue: "dev", promptAtRuntime: true },
    ];
    mocks.promptForVariables.mockResolvedValue({ env: "prod" });
    const values = await resolveQuickPromptVariables(specs, {});
    expect(values).toEqual({ env: "prod" });
    // The default pre-fills the prompt.
    const preset = mocks.promptForVariables.mock.calls[0]?.[1];
    expect(preset).toEqual({ env: "dev" });
  });

  it("returns null when the user cancels the variable prompt", async () => {
    mocks.promptForVariables.mockResolvedValue(null);
    const values = await resolveQuickPromptVariables([{ name: "x" }], {});
    expect(values).toBeNull();
  });
});

describe("runQuickPromptFlow", () => {
  it("submits collected values for a non-admin command", async () => {
    mocks.promptForVariables.mockResolvedValue({ target: "/x" });
    const result = await runQuickPromptFlow(
      baseRequest({ variables: [{ name: "target" }] }),
    );
    expect(result).toBe("submitted");
    expect(mocks.submitQuickPrompt).toHaveBeenCalledWith(
      { target: "/x" },
      undefined,
    );
    expect(mocks.promptForAdminPassword).not.toHaveBeenCalled();
  });

  it("injects the selected path as the reserved variable", async () => {
    const result = await runQuickPromptFlow(
      baseRequest({
        variables: [{ name: "PROCMIX_SELECTED_PATH" }],
        selectedPath: "/home/user/proj",
      }),
    );
    expect(result).toBe("submitted");
    expect(mocks.submitQuickPrompt).toHaveBeenCalledWith(
      { PROCMIX_SELECTED_PATH: "/home/user/proj" },
      undefined,
    );
    // No prompt needed — the path satisfied the only variable.
    expect(mocks.promptForVariables).not.toHaveBeenCalled();
  });

  it("Continue (remember=false): forwards a one-shot password, does not save", async () => {
    mocks.promptForAdminPassword.mockResolvedValue({
      password: "hunter2",
      remember: false,
    });
    const result = await runQuickPromptFlow(baseRequest({ needsAdmin: true }));
    expect(result).toBe("submitted");
    expect(mocks.submitQuickPrompt).toHaveBeenCalledWith({}, "hunter2");
    expect(mocks.setAdminPassword).not.toHaveBeenCalled();
  });

  it("Save & continue (remember=true): persists to keychain, no one-shot", async () => {
    mocks.promptForAdminPassword.mockResolvedValue({
      password: "hunter2",
      remember: true,
    });
    const result = await runQuickPromptFlow(baseRequest({ needsAdmin: true }));
    expect(result).toBe("submitted");
    expect(mocks.setAdminPassword).toHaveBeenCalledWith("hunter2");
    // Saved → the executor reads it from the keychain, so no one-shot forward.
    expect(mocks.submitQuickPrompt).toHaveBeenCalledWith({}, undefined);
  });

  it("Save & continue: falls back to one-shot if saving fails", async () => {
    mocks.promptForAdminPassword.mockResolvedValue({
      password: "hunter2",
      remember: true,
    });
    mocks.setAdminPassword.mockRejectedValue(new Error("keychain unavailable"));
    const result = await runQuickPromptFlow(baseRequest({ needsAdmin: true }));
    // The launch still proceeds, one-shot, rather than being lost.
    expect(result).toBe("submitted");
    expect(mocks.submitQuickPrompt).toHaveBeenCalledWith({}, "hunter2");
  });

  it("cancelling the variable prompt aborts and calls cancelQuickPrompt", async () => {
    mocks.promptForVariables.mockResolvedValue(null);
    const result = await runQuickPromptFlow(
      baseRequest({ variables: [{ name: "x" }] }),
    );
    expect(result).toBe("cancelled");
    expect(mocks.cancelQuickPrompt).toHaveBeenCalledOnce();
    expect(mocks.submitQuickPrompt).not.toHaveBeenCalled();
  });

  it("cancelling the admin prompt aborts the run", async () => {
    mocks.promptForAdminPassword.mockResolvedValue(null);
    const result = await runQuickPromptFlow(baseRequest({ needsAdmin: true }));
    expect(result).toBe("cancelled");
    expect(mocks.cancelQuickPrompt).toHaveBeenCalledOnce();
    expect(mocks.submitQuickPrompt).not.toHaveBeenCalled();
  });
});
