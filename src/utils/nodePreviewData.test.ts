import { describe, expect, it } from "vitest";
import type { Command, DataAssignment, ExtractedResult } from "../types";
import type { WorkflowNodeOutput } from "../stores/workflowRunStore";
import type { WorkflowFlowNode } from "./workflowGraph";
import {
  hasRaw,
  hasStructured,
  nodeRunOutput,
  predecessorOutputSchema,
  previewText,
  rawText,
  resolveAssignmentDisplayValue,
  structuredText,
} from "./nodePreviewData";

describe("nodeRunOutput", () => {
  it("returns null when the node produced no captured output", () => {
    expect(nodeRunOutput(undefined)).toBeNull();
    // An entry with neither stdout nor result is also "no output".
    expect(nodeRunOutput({ stdout: "" })).toBeNull();
  });

  it("carries BOTH the structured extraction and the raw stdout", () => {
    const nodeOutput: WorkflowNodeOutput = {
      stdout: "raw",
      result: { fields: { a: 1 }, returnValue: { a: 1 } },
    };
    const out = nodeRunOutput(nodeOutput);
    expect(out).toEqual({
      structured: { fields: { a: 1 }, returnValue: { a: 1 } },
      text: "raw",
      truncated: false,
    });
    expect(hasStructured(out)).toBe(true);
    expect(hasRaw(out)).toBe(true);
    // The default view prefers the structured shape.
    expect(previewText(out)).toBe('{\n  "a": 1\n}');
    expect(rawText(out)).toBe("raw");
    expect(structuredText(out)).toBe('{\n  "a": 1\n}');
  });

  it("shows raw stdout when there is no structured result", () => {
    const out = nodeRunOutput({ stdout: "one\ntwo" });
    expect(out).toEqual({
      structured: undefined,
      text: "one\ntwo",
      truncated: false,
    });
    expect(hasStructured(out)).toBe(false);
    expect(hasRaw(out)).toBe(true);
  });

  it("returns a result-only output when there is no stdout", () => {
    const out = nodeRunOutput({
      stdout: "",
      result: { fields: { ok: true }, returnValue: true },
    });
    expect(hasStructured(out)).toBe(true);
    expect(hasRaw(out)).toBe(false);
    expect(out?.text).toBeUndefined();
  });

  it("truncates a long stdout to its tail and flags it", () => {
    const out = nodeRunOutput({ stdout: "x".repeat(5000) });
    expect(out?.truncated).toBe(true);
    expect(out?.text?.length).toBe(4000);
  });
});

describe("previewText", () => {
  it("returns empty string for null", () => {
    expect(previewText(null)).toBe("");
  });

  it("pretty-prints a structured return value", () => {
    expect(
      previewText({
        structured: { fields: {}, returnValue: { a: 1 } },
        truncated: false,
      }),
    ).toBe('{\n  "a": 1\n}');
  });

  it("surfaces an extraction error verbatim", () => {
    expect(
      previewText({
        structured: { fields: {}, returnValue: null, error: "bad json" },
        truncated: false,
      }),
    ).toBe("bad json");
  });

  it("shows raw text when there is no structured result", () => {
    expect(previewText({ text: "hello", truncated: false })).toBe("hello");
  });
});

describe("structuredText", () => {
  it("returns an empty string when there is no structured result", () => {
    expect(structuredText(null)).toBe("");
    expect(structuredText({ text: "raw", truncated: false })).toBe("");
  });

  it("stringifies a non-serialisable (cyclic) value via the catch fallback", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = structuredText({
      structured: { fields: {}, returnValue: cyclic },
      truncated: false,
    });
    expect(result).toBe("[object Object]");
  });
});

function commandNode(commandId: string): WorkflowFlowNode {
  return {
    id: "p",
    type: "command",
    position: { x: 0, y: 0 },
    data: { kind: "command", commandId },
  };
}

function command(id: string, withSchema: boolean): Command {
  return {
    id,
    name: id,
    script: "echo",
    shell: "bash",
    variables: [],
    tags: [],
    favorite: false,
    createdAt: "",
    updatedAt: "",
    outputSchema: withSchema
      ? { pipeline: [{ parser: "regex", fields: [{ name: "f" }] }] }
      : undefined,
  } as unknown as Command;
}

describe("predecessorOutputSchema", () => {
  it("returns the command's schema when it declares one", () => {
    const schema = predecessorOutputSchema(commandNode("c1"), [
      command("c1", true),
    ]);
    expect(schema?.pipeline.length).toBe(1);
  });

  it("returns undefined for a command without a schema", () => {
    expect(
      predecessorOutputSchema(commandNode("c1"), [command("c1", false)]),
    ).toBeUndefined();
  });

  it("returns a parser node's own schema", () => {
    const parser: WorkflowFlowNode = {
      id: "p",
      type: "parser",
      position: { x: 0, y: 0 },
      data: {
        kind: "parser",
        parser: { pipeline: [{ parser: "regex", fields: [{ name: "v" }] }] },
      },
    };
    expect(predecessorOutputSchema(parser, [])?.pipeline.length).toBe(1);
  });

  it("returns undefined when there is no predecessor", () => {
    expect(predecessorOutputSchema(null, [])).toBeUndefined();
  });

  it("returns undefined for a command node with no commandId", () => {
    const noCmd: WorkflowFlowNode = {
      id: "p",
      type: "command",
      position: { x: 0, y: 0 },
      data: { kind: "command" },
    };
    expect(predecessorOutputSchema(noCmd, [])).toBeUndefined();
  });
});

describe("resolveAssignmentDisplayValue", () => {
  const ph = (k: string): string => `<${k}>`;
  const assign = (source: DataAssignment["source"]): DataAssignment => ({
    name: "v",
    value: "",
    source,
  });
  const result: ExtractedResult = {
    fields: { host: "example.com" },
    returnValue: { host: "example.com" },
  };

  it("shows a manual literal verbatim", () => {
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "manual", value: "hi" }),
        "raw",
        null,
        ph,
      ),
    ).toBe("hi");
  });

  it("resolves rawOutput to the input raw text (req 1)", () => {
    expect(
      resolveAssignmentDisplayValue(assign({ kind: "rawOutput" }), "80", null, ph),
    ).toBe("80");
  });

  it("resolves a field from the input extraction", () => {
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "field", field: "host" }),
        "raw",
        result,
        ph,
      ),
    ).toBe("example.com");
  });

  it("resolves schemaOutput to the whole extracted result as JSON", () => {
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "schemaOutput" }),
        "raw",
        result,
        ph,
      ),
    ).toBe('{"host":"example.com"}');
  });

  it("falls back to a placeholder for a run-time-only source", () => {
    expect(
      resolveAssignmentDisplayValue(assign({ kind: "exitCode" }), "raw", null, ph),
    ).toBe("<exitCode>");
    // schema/field with no extraction also falls back.
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "field", field: "host" }),
        "raw",
        null,
        ph,
      ),
    ).toBe("<field>");
  });

  it("falls back to the schemaOutput placeholder when there is no extraction", () => {
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "schemaOutput" }),
        "raw",
        null,
        ph,
      ),
    ).toBe("<schemaOutput>");
  });

  it("stringifies a non-serialisable field value via the catch fallback", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicResult: ExtractedResult = {
      fields: { host: cyclic },
      returnValue: null,
    };
    expect(
      resolveAssignmentDisplayValue(
        assign({ kind: "field", field: "host" }),
        "raw",
        cyclicResult,
        ph,
      ),
    ).toBe("[object Object]");
  });
});
