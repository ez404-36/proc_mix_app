import { describe, expect, it } from "vitest";

import type { AssistantPatch, AssistantPatchOperation } from "../types/assistant";
import type { FormState } from "../types/commandForm";
import type { MiniApp } from "../types/miniapp";
import {
  applyAssistantPatchToCommandForm,
  applyAssistantPatchToMiniApp,
  applyAssistantPatchToWorkflowDraft,
} from "./assistantPatches";

function patch(path: string, value: unknown): AssistantPatch {
  const operation: AssistantPatchOperation = { op: "replace", path, value };
  return { summary: "test", operations: [operation] };
}

const form: FormState = {
  name: "Old",
  description: "",
  script: "echo old",
  shell: "bash",
  tags: [],
  category: "",
  runAsAdmin: false,
  variables: [],
  timeoutSeconds: "",
  disableHints: false,
  envRows: [],
  workingDir: "",
  promptWorkingDir: false,
  target: { kind: "local" },
  promptSshPassword: false,
  apiEnabled: false,
  apiSlug: "",
  explorerEnabled: false,
  explorerPathVariable: "",
  outputSchema: undefined,
  sound: undefined,
};

describe("assistant patch adapters", () => {
  it("applies a command scalar and converts variable specs to editable rows", () => {
    const result = applyAssistantPatchToCommandForm(
      {
        summary: "Update",
        operations: [
          { op: "replace", path: "script", value: "echo new" },
          {
            op: "replace",
            path: "variables",
            value: [{ name: "TOKEN", sensitive: true }],
          },
        ],
      },
      form,
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.script).toBe("echo new");
      expect(result.value.variables[0]).toMatchObject({
        name: "TOKEN",
        sensitive: true,
        promptAtRuntime: true,
      });
    }
  });

  it("appends one variable via variables.append and keeps existing rows", () => {
    const withExisting: FormState = {
      ...form,
      variables: [
        {
          rowId: "row-1",
          name: "HOST",
          defaultValue: "localhost",
          description: "",
          sensitive: false,
          promptAtRuntime: false,
          nameTouched: true,
        },
      ],
    };
    const result = applyAssistantPatchToCommandForm(
      {
        summary: "Add port variable",
        operations: [
          {
            op: "add",
            path: "variables.append",
            value: { name: "port" },
          },
        ],
      },
      withExisting,
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.variables).toHaveLength(2);
      expect(result.value.variables[0]).toMatchObject({
        name: "HOST",
        defaultValue: "localhost",
      });
      expect(result.value.variables[1]).toMatchObject({
        name: "port",
        defaultValue: "",
        promptAtRuntime: true,
      });
    }
  });

  it("rejects a malformed variables.append payload", () => {
    expect(
      applyAssistantPatchToCommandForm(patch("variables.append", "port"), form),
    ).toEqual({ ok: false, error: "invalidValue" });
  });

  it("rejects protected and unsupported command paths", () => {
    expect(applyAssistantPatchToCommandForm(patch("id", "new"), form)).toEqual({
      ok: false,
      error: "unsupportedPath",
    });
    expect(
      applyAssistantPatchToCommandForm(patch("sound.volume", 1), form),
    ).toEqual({ ok: false, error: "unsupportedPath" });
  });

  it("rejects workflow edges with unknown node references", () => {
    const result = applyAssistantPatchToWorkflowDraft(
      patch("edges", [{ id: "edge", source: "a", target: "missing", sourceHandle: "out" }]),
      { name: "Flow", nodes: [{ id: "a", type: "end", position: { x: 0, y: 0 }, data: { kind: "end" } }], edges: [], tags: [] },
    );

    expect(result).toEqual({ ok: false, error: "invalidValue" });
  });

  it("rejects mini-app widgets that lack layout geometry", () => {
    const miniApp = {
      name: "Panel",
      widgets: [],
      tags: [],
      panelSize: { w: 400, h: 300 },
    } as unknown as MiniApp;
    const result = applyAssistantPatchToMiniApp(
      patch("widgets", [{ id: "widget", kind: "button" }]),
      miniApp,
    );

    expect(result).toEqual({ ok: false, error: "invalidValue" });
  });
});
