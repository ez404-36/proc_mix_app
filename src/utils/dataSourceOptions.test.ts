import { describe, expect, it } from "vitest";
import type { Command } from "../types";
import {
  commandSchemaFieldNames,
  dataSourceId,
  dataSourceOptions,
} from "./dataSourceOptions";
import type { WorkflowFlowNode } from "./workflowGraph";

function flowNode(
  id: string,
  kind: WorkflowFlowNode["data"]["kind"],
  commandId?: string,
): WorkflowFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, commandId } };
}

function command(id: string, fields: string[]): Command {
  return {
    id,
    name: id,
    script: "echo hi",
    shell: "bash",
    variables: [],
    tags: [],
    favorite: false,
    createdAt: "",
    updatedAt: "",
    outputSchema:
      fields.length === 0
        ? undefined
        : {
            pipeline: [
              {
                parser: "regex",
                fields: fields.map((name) => ({ name })),
              },
            ],
          },
  } as unknown as Command;
}

/** A command whose schema uses a fieldless parser (e.g. `raw` / `keyValue`):
 * it HAS a schema (so `schemaOutput` is meaningful) but declares no named
 * fields. */
function commandWithFieldlessSchema(id: string): Command {
  return {
    id,
    name: id,
    script: "echo hi",
    shell: "bash",
    variables: [],
    tags: [],
    favorite: false,
    createdAt: "",
    updatedAt: "",
    outputSchema: { pipeline: [{ parser: "raw", fields: [] }] },
  } as unknown as Command;
}

const ids = (
  predecessor: WorkflowFlowNode | null,
  commands: Command[],
): string[] => dataSourceOptions(predecessor, commands).map((o) => o.id);

describe("dataSourceOptions", () => {
  it("offers only manual + universal sources when the predecessor is unknown", () => {
    expect(ids(null, [])).toEqual(["manual", "rawOutput", "exitCode"]);
  });

  it("offers manual only after a non-value predecessor (start/data/end)", () => {
    expect(ids(flowNode("s", "start"), [])).toEqual(["manual"]);
    expect(ids(flowNode("d", "data"), [])).toEqual(["manual"]);
    expect(ids(flowNode("e", "end"), [])).toEqual(["manual"]);
  });

  it("offers raw/exit + schema output + fields after a command with a schema", () => {
    const cmd = command("c1", ["count", "name"]);
    const got = ids(flowNode("n", "command", "c1"), [cmd]);
    expect(got).toEqual([
      "manual",
      "rawOutput",
      "exitCode",
      "schemaOutput",
      "field:count",
      "field:name",
    ]);
  });

  it("omits schema sources for a command WITHOUT a schema", () => {
    const cmd = command("c1", []);
    const got = ids(flowNode("n", "command", "c1"), [cmd]);
    expect(got).toEqual(["manual", "rawOutput", "exitCode"]);
    expect(got).not.toContain("schemaOutput");
  });

  it("offers schemaOutput for a command with a fieldless schema (raw/keyValue)", () => {
    // Regression: a `raw`/`keyValue` parser declares no named fields but still
    // produces a meaningful whole-result, so `schemaOutput` MUST be offered
    // (only the per-field options depend on declared fields).
    const cmd = commandWithFieldlessSchema("c1");
    const got = ids(flowNode("n", "command", "c1"), [cmd]);
    expect(got).toContain("schemaOutput");
    expect(got).toEqual(["manual", "rawOutput", "exitCode", "schemaOutput"]);
  });

  it("adds retryCount after a try, conditionResult after a condition, matchedCase after a switch", () => {
    const cmd = command("c1", []);
    expect(ids(flowNode("n", "try", "c1"), [cmd])).toContain("retryCount");
    expect(ids(flowNode("n", "condition", "c1"), [cmd])).toContain(
      "conditionResult",
    );
    expect(ids(flowNode("n", "switch", "c1"), [cmd])).toContain("matchedCase");
  });

  it("offers raw/schema output + fields after a parser node with a schema", () => {
    const parserNode: WorkflowFlowNode = {
      id: "p",
      type: "parser",
      position: { x: 0, y: 0 },
      data: {
        kind: "parser",
        parser: {
          pipeline: [
            {
              parser: "regex",
              fields: [{ name: "ver" }, { name: "build" }],
            },
          ],
        },
      },
    };
    expect(ids(parserNode, [])).toEqual([
      "manual",
      "rawOutput",
      "schemaOutput",
      "field:ver",
      "field:build",
    ]);
  });

  it("offers raw output only after a parser node without a schema", () => {
    const parserNode: WorkflowFlowNode = {
      id: "p",
      type: "parser",
      position: { x: 0, y: 0 },
      data: { kind: "parser" },
    };
    expect(ids(parserNode, [])).toEqual(["manual", "rawOutput"]);
  });

  it("offers raw output after a text node", () => {
    const textNode: WorkflowFlowNode = {
      id: "tx",
      type: "text",
      position: { x: 0, y: 0 },
      data: { kind: "text", text: "hi ${x}" },
    };
    expect(ids(textNode, [])).toEqual(["manual", "rawOutput"]);
  });

  it("offers loop iteration count after a loop", () => {
    expect(ids(flowNode("n", "loop"), [])).toEqual([
      "manual",
      "loopIterations",
    ]);
  });
});

describe("commandSchemaFieldNames", () => {
  it("dedupes across pipeline steps, dropping empties", () => {
    const cmd = command("c", ["a", "b", "a", ""]);
    expect(commandSchemaFieldNames(cmd)).toEqual(["a", "b"]);
  });

  it("is empty for a command with no schema", () => {
    expect(commandSchemaFieldNames(command("c", []))).toEqual([]);
  });
});

describe("dataSourceId", () => {
  it("round-trips the option id for a stored source", () => {
    expect(dataSourceId({ kind: "rawOutput" })).toBe("rawOutput");
    expect(dataSourceId({ kind: "manual", value: "x" })).toBe("manual");
    expect(dataSourceId({ kind: "field", field: "count" })).toBe(
      "field:count",
    );
  });
});
