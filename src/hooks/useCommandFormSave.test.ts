import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCommandMock = vi.fn();
const updateCommandMock = vi.fn();
vi.mock("../services/commandActions", () => ({
  createCommand: (input: unknown) => createCommandMock(input),
  updateCommand: (id: string, patch: unknown) => updateCommandMock(id, patch),
}));

import { useCommandFormSave } from "./useCommandFormSave";
import type { UseCommandFormSaveParams } from "./useCommandFormSave";
import type { Command } from "../types";
import type { FormErrors, FormState } from "../types/commandForm";

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
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

interface Harness {
  params: UseCommandFormSaveParams;
  setShowErrors: ReturnType<typeof vi.fn>;
  setActiveTab: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onDirtyChange: ReturnType<typeof vi.fn>;
  cancelActiveRunForSave: ReturnType<typeof vi.fn>;
  teardownRun: ReturnType<typeof vi.fn>;
}

function makeParams(overrides: Partial<UseCommandFormSaveParams> = {}): Harness {
  const setShowErrors = vi.fn();
  const setActiveTab = vi.fn();
  const onClose = vi.fn();
  const onDirtyChange = vi.fn();
  const cancelActiveRunForSave = vi.fn();
  const teardownRun = vi.fn();
  const params: UseCommandFormSaveParams = {
    form: makeForm(),
    mode: "create",
    command: null,
    errors: {},
    hasErrors: false,
    hasVariableErrors: false,
    setShowErrors,
    setActiveTab,
    onClose,
    onDirtyChange,
    cancelActiveRunForSave,
    teardownRun,
    ...overrides,
  };
  return {
    params,
    setShowErrors,
    setActiveTab,
    onClose,
    onDirtyChange,
    cancelActiveRunForSave,
    teardownRun,
  };
}

beforeEach(() => {
  createCommandMock.mockReset();
  updateCommandMock.mockReset();
  createCommandMock.mockImplementation((input) => ({
    ...(input as object),
    id: "new-id",
  }));
  updateCommandMock.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCommandFormSave validation gating", () => {
  it("reveals errors and jumps to main tab for a name error", () => {
    const h = makeParams({
      hasErrors: true,
      errors: { name: "required" } satisfies FormErrors,
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(h.setShowErrors).toHaveBeenCalledWith(true);
    expect(h.setActiveTab).toHaveBeenCalledWith("main");
    expect(createCommandMock).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("jumps to main tab for an apiSlug error", () => {
    const h = makeParams({
      hasErrors: true,
      errors: { apiSlug: "bad" } satisfies FormErrors,
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(h.setActiveTab).toHaveBeenCalledWith("main");
  });

  it("jumps to script tab for a script error", () => {
    const h = makeParams({
      hasErrors: true,
      errors: { script: "empty" } satisfies FormErrors,
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(h.setActiveTab).toHaveBeenCalledWith("script");
  });

  it("jumps to script tab for a variable error", () => {
    const h = makeParams({ hasErrors: true, hasVariableErrors: true, errors: {} });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(h.setActiveTab).toHaveBeenCalledWith("script");
  });

  it("does not switch tabs when hasErrors is set but no field maps to a tab", () => {
    const h = makeParams({ hasErrors: true, errors: {} });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(h.setShowErrors).toHaveBeenCalledWith(true);
    expect(h.setActiveTab).not.toHaveBeenCalled();
  });
});

describe("useCommandFormSave create path", () => {
  it("creates a minimal command and completes the teardown/close sequence", () => {
    const h = makeParams({
      form: makeForm({ name: "  Trimmed  ", script: "  echo x  " }),
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(createCommandMock).toHaveBeenCalledTimes(1);
    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.name).toBe("Trimmed");
    expect(input.script).toBe("echo x");
    expect(input.favorite).toBe(false);
    // Optional keys omitted when empty.
    expect(input).not.toHaveProperty("categoryId");
    expect(input).not.toHaveProperty("variables");
    expect(input).not.toHaveProperty("target");

    expect(h.cancelActiveRunForSave).toHaveBeenCalledTimes(1);
    expect(h.onDirtyChange).toHaveBeenCalledWith(false);
    expect(h.teardownRun).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("includes all optional fields when populated on create", () => {
    const h = makeParams({
      form: makeForm({
        description: " a desc ",
        category: " Cat ",
        timeoutSeconds: "30",
        envRows: [{ rowId: "e", key: "K", value: "V" }],
        workingDir: " /tmp ",
        promptWorkingDir: true,
        apiEnabled: true,
        apiSlug: " slug ",
      }),
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.description).toBe("a desc");
    expect(input.categoryId).toBe("Cat");
    expect(input.timeoutSeconds).toBe(30);
    expect(input.env).toEqual({ K: "V" });
    expect(input.workingDir).toBe("/tmp");
    expect(input.promptWorkingDir).toBe(true);
    expect(input.apiEnabled).toBe(true);
    expect(input.apiSlug).toBe("slug");
  });

  it("detects inline escalation in the script on save", () => {
    const h = makeParams({ form: makeForm({ script: "sudo apt update" }) });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.runAsAdmin).toBe(true);
  });

  it("forces runAsAdmin off for a remote target and persists the target", () => {
    const h = makeParams({
      form: makeForm({
        runAsAdmin: true,
        target: { kind: "remote", alias: "box" },
        promptSshPassword: true,
      }),
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.runAsAdmin).toBe(false);
    expect(input.target).toEqual({ kind: "remote", alias: "box" });
    expect(input.promptSshPassword).toBe(true);
  });

  it("stamps local scope + workflow id when created inside a workflow editor", () => {
    const h = makeParams({
      initialScope: "local",
      initialWorkflowId: "wf-9",
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.scope).toBe("local");
    expect(input.workflowId).toBe("wf-9");
  });

  it("includes explorer + sound fields when configured on create", () => {
    const h = makeParams({
      form: makeForm({
        explorerEnabled: true,
        explorerPathVariable: " PATHVAR ",
        variables: [
          {
            rowId: "v",
            name: "PATHVAR",
            defaultValue: "",
            description: "",
            sensitive: false,
            promptAtRuntime: true,
            nameTouched: false,
          },
        ],
        outputSchema: undefined,
      }),
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const input = createCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.explorerEnabled).toBe(true);
    expect(input.explorerPathVariable).toBe("PATHVAR");
    expect(input.variables).toBeDefined();
  });
});

describe("useCommandFormSave edit path", () => {
  it("updates an existing command with an explicit patch", () => {
    const command = makeCommand();
    const h = makeParams({
      mode: "edit",
      command,
      form: makeForm({ name: "Renamed", tags: ["a", "a", "b"] }),
    });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(updateCommandMock).toHaveBeenCalledTimes(1);
    const [id, patch] = updateCommandMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("cmd-1");
    expect(patch.name).toBe("Renamed");
    expect(patch.tags).toEqual(["a", "b"]);
    expect(patch).toHaveProperty("target");
    expect(patch.target).toBeUndefined();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("drops seed translation keys when a seed command is edited", () => {
    const command = makeCommand({
      nameKey: "seed.name",
      descriptionKey: "seed.desc",
    });
    const h = makeParams({ mode: "edit", command, form: makeForm() });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const [, patch] = updateCommandMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch).toHaveProperty("nameKey");
    expect(patch.nameKey).toBeUndefined();
    expect(patch).toHaveProperty("descriptionKey");
    expect(patch.descriptionKey).toBeUndefined();
  });

  it("does not add key drops when the edited command has no seed keys", () => {
    const command = makeCommand();
    const h = makeParams({ mode: "edit", command, form: makeForm() });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    const [, patch] = updateCommandMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch).not.toHaveProperty("nameKey");
    expect(patch).not.toHaveProperty("descriptionKey");
  });

  it("falls back to the create path when mode is edit but command is null", () => {
    const h = makeParams({ mode: "edit", command: null });
    const { result } = renderHook(() => useCommandFormSave(h.params));

    act(() => {
      result.current.handleSave();
    });

    expect(createCommandMock).toHaveBeenCalledTimes(1);
    expect(updateCommandMock).not.toHaveBeenCalled();
  });
});
