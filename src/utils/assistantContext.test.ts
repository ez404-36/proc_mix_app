import { describe, expect, it } from "vitest";

import type { Command } from "../types/command";
import type { FormState } from "../types/commandForm";
import { REDACTION } from "./redactSecrets";
import {
  buildCommandAssistantContext,
  buildCommandFormAssistantContext,
  buildMiniAppAssistantContext,
  buildWorkflowAssistantContext,
  createAssistantDraftVersion,
} from "./assistantContext";

const command = {
  id: "command-1",
  name: "Database query",
  script: "psql --password=$PASSWORD -c 'select 1'",
  env: { PASSWORD: "literal-secret" },
  tags: ["db"],
  favorite: false,
  createdAt: "",
  updatedAt: "",
  runCount: 0,
  runAsAdmin: false,
  variables: [
    {
      name: "PASSWORD",
      defaultValue: "hunter2",
      sensitive: true,
      description: "postgres password",
    },
  ],
  outputSchema: {
    pipeline: [{ parser: "regex", pattern: "version=(?<version>\\S+)" }],
    sample: "token=abc123 version=1",
  },
} as unknown as Command;

const commandWithPlainDefault = {
  ...command,
  variables: [
    {
      name: "port",
      defaultValue: "8080",
    },
  ],
} as unknown as Command;

describe("assistant context builders", () => {
  it("creates draft versions within the backend u32 range", () => {
    const version = createAssistantDraftVersion({ name: "test" });

    expect(version).toBeGreaterThan(0);
    expect(version).toBeLessThanOrEqual(0xffffffff);
    expect(createAssistantDraftVersion({ name: "test" })).toBe(version);
    expect(createAssistantDraftVersion({ name: "changed" })).not.toBe(version);
  });

  it("sends command shape without env or secret variable values", () => {
    const context = buildCommandAssistantContext(command, 4);
    const json = JSON.stringify(context);

    expect(context.target).toBe("command");
    expect(context.draft.variables?.[0]).toMatchObject({
      name: "PASSWORD",
      hasDefault: true,
      sensitive: true,
    });
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("literal-secret");
    expect(context.draft.outputSchema?.sample).toContain(REDACTION);
  });

  it("includes non-sensitive variable defaults for lossless rewrites", () => {
    const context = buildCommandAssistantContext(commandWithPlainDefault, 1);

    expect(context.draft.variables?.[0]).toMatchObject({
      name: "port",
      hasDefault: true,
      defaultValue: "8080",
    });
  });

  it("redacts workflow manual variable sources", () => {
    const context = buildWorkflowAssistantContext(
      {
      id: "workflow-1",
      name: "Deploy",
      nodes: [
        {
          id: "node-1",
          kind: "command",
          commandId: "command-1",
          variableSources: { PASSWORD: { kind: "manual", value: "plain-secret" } },
          data: [{ name: "token", value: "plain-secret", source: { kind: "manual", value: "plain-secret" } }],
        },
      ],
      edges: [],
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      runCount: 0,
      } as never,
      2,
    );
    const draft = context.draft as { nodes: unknown[] };
    const node = draft.nodes[0] as Record<string, unknown>;
    const sources = node.variableSources as Record<string, { value: string }>;
    const assignments = node.data as { value: string }[];

    expect(sources.PASSWORD.value).toBe(REDACTION);
    expect(assignments[0]?.value).toBe(REDACTION);
    expect(JSON.stringify(context)).not.toContain("plain-secret");
  });

  it("masks secret mini-app artifacts", () => {
    const context = buildMiniAppAssistantContext(
      {
      id: "miniapp-1",
      name: "VPN",
      widgets: [
        {
          id: "widget-1",
          kind: "artifact",
          name: "password",
          label: "Password",
          value: "vpn-secret",
          variant: "secret",
        },
      ],
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      runCount: 0,
      panelSize: { w: 400, h: 300 },
      } as never,
      1,
    );
    const draft = context.draft as { widgets: unknown[] };
    const widget = draft.widgets[0] as { value: string };

    expect(widget.value).toBe(REDACTION);
  });

  it("keeps form variable defaults only when they are not sensitive", () => {
    const form = {
      name: "Server",
      description: "",
      script: "./server --port ${port}",
      shell: "bash",
      tags: [],
      category: "",
      runAsAdmin: false,
      variables: [
        {
          rowId: "row-1",
          name: "port",
          defaultValue: "8080",
          description: "",
          sensitive: false,
          promptAtRuntime: true,
          nameTouched: true,
        },
        {
          rowId: "row-2",
          name: "token",
          defaultValue: "token-secret",
          description: "",
          sensitive: true,
          promptAtRuntime: false,
          nameTouched: true,
        },
      ],
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
    } as FormState;
    const context = buildCommandFormAssistantContext(form, 1);
    const json = JSON.stringify(context);

    expect(context.draft.args).toBeUndefined();
    expect(json).not.toContain('"args"');
    expect(context.draft.variables?.[0]).toMatchObject({
      name: "port",
      defaultValue: "8080",
    });
    expect(context.draft.variables?.[1]).toMatchObject({
      name: "token",
      hasDefault: true,
      defaultValue: undefined,
    });
    expect(json).not.toContain("token-secret");
  });
});
