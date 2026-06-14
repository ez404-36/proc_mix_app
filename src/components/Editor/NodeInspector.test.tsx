// Render tests for the node-editor modal. NodeInspector is now a self-
// contained portal modal (no reactflow dependency), so it can be rendered
// directly with the real i18n bundle.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The parser node embeds OutputSchemaEditor, which calls the extraction IPC
// and uses Arco's Message. Stub both so the modal renders in jsdom.
vi.mock("../../services/outputExtraction", () => ({
  previewExtraction: vi.fn().mockResolvedValue({
    fields: {},
    returnValue: null,
    error: undefined,
  }),
}));
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import i18n from "../../i18n";
import type { Command } from "../../types";
import type { NodeRunOutput } from "../../utils/nodePreviewData";
import type {
  WorkflowFlowEdge,
  WorkflowFlowNode,
} from "../../utils/workflowGraph";
import { ContextMenuProvider } from "../ContextMenu";
import { NodeInspector } from "./NodeInspector";

function flowNode(
  kind: WorkflowFlowNode["data"]["kind"],
  id = "n1",
): WorkflowFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind } };
}

interface Overrides {
  inputPreview?: NodeRunOutput | null;
  outputPreview?: NodeRunOutput | null;
  manualInput?: string;
  manualOutput?: string;
  isRunning?: boolean;
  allNodes?: WorkflowFlowNode[];
  edges?: WorkflowFlowEdge[];
  onDelete?: (id: string) => void;
  onManualInputChange?: (id: string, v: string) => void;
  onRunNode?: (id: string, seedInput: string | null) => void;
}

function renderModal(node: WorkflowFlowNode, over: Overrides = {}) {
  const onClose = vi.fn();
  const onDelete = over.onDelete ?? vi.fn();
  const onManualInputChange = over.onManualInputChange ?? vi.fn();
  const onRunNode = over.onRunNode ?? vi.fn();
  const onNodeDataChange = vi.fn();
  const { unmount } = render(
    // The text-node editor uses `useContextMenu`, so a provider is required.
    <ContextMenuProvider>
      <NodeInspector
        node={node}
        predecessor={null}
        allNodes={over.allNodes ?? [node]}
        edges={over.edges ?? []}
        commands={[]}
        inputPreview={over.inputPreview ?? null}
        outputPreview={over.outputPreview ?? null}
        manualInput={over.manualInput ?? ""}
        manualOutput={over.manualOutput ?? ""}
        isRunning={over.isRunning ?? false}
        onManualInputChange={onManualInputChange}
        onManualOutputChange={vi.fn()}
        onCommandChange={vi.fn()}
        onNodeDataChange={onNodeDataChange}
        onDelete={onDelete}
        onRunNode={onRunNode}
        onClose={onClose}
      />
    </ContextMenuProvider>,
  );
  return {
    onClose,
    onDelete,
    onManualInputChange,
    onRunNode,
    onNodeDataChange,
    unmount,
  };
}

describe("NodeInspector modal", () => {
  it("shows the node-kind label as the dialog title", () => {
    renderModal(flowNode("command"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe(
      i18n.t("editor.nodes.command"),
    );
  });

  it("renders both preview column headings", () => {
    renderModal(flowNode("command"));
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.inputTitle")),
    ).toBeTruthy();
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.resultTitle")),
    ).toBeTruthy();
  });

  it("offers a manual-entry textarea when there is no live data", () => {
    const { onManualInputChange } = renderModal(flowNode("command"));
    const input = screen.getByLabelText(
      i18n.t("editor.inspector.preview.inputTitle"),
    ) as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onManualInputChange).toHaveBeenCalledWith("n1", "hello");
  });

  it("shows live run data read-only instead of the textarea", () => {
    renderModal(flowNode("command"), {
      outputPreview: { text: "run output", truncated: false },
    });
    expect(screen.getByText("run output")).toBeTruthy();
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.fromRun")),
    ).toBeTruthy();
  });

  it("offers raw/schema tabs when the run produced both", () => {
    renderModal(flowNode("command"), {
      outputPreview: {
        text: "raw stdout",
        structured: { fields: { a: 1 }, returnValue: { a: 1 } },
        truncated: false,
      },
    });
    // Defaults to the schema view.
    expect(screen.getByText('{', { exact: false })).toBeTruthy();
    const rawTab = screen.getByRole("tab", {
      name: i18n.t("editor.inspector.preview.tabRaw"),
    });
    fireEvent.click(rawTab);
    expect(screen.getByText("raw stdout")).toBeTruthy();
  });

  it("shows no tabs when only raw output is present", () => {
    renderModal(flowNode("command"), {
      outputPreview: { text: "just stdout", truncated: false },
    });
    expect(
      screen.queryByRole("tab", {
        name: i18n.t("editor.inspector.preview.tabSchema"),
      }),
    ).toBeNull();
    expect(screen.getByText("just stdout")).toBeTruthy();
  });

  it("deletes a non-start node via the trash action", () => {
    const { onDelete } = renderModal(flowNode("command"));
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("editor.inspector.deleteNode"),
      }),
    );
    expect(onDelete).toHaveBeenCalledWith("n1");
  });

  it("hides the delete action on the start node", () => {
    renderModal(flowNode("start", "n-start"));
    expect(
      screen.queryByRole("button", {
        name: i18n.t("editor.inspector.deleteNode"),
      }),
    ).toBeNull();
  });

  it("shows a data node's saved variables as a key=value block (not a textarea)", () => {
    const node: WorkflowFlowNode = {
      id: "d1",
      type: "data",
      position: { x: 0, y: 0 },
      data: {
        kind: "data",
        data: [
          { name: "host", value: "example.com", source: { kind: "manual", value: "example.com" } },
          { name: "raw", value: "", source: { kind: "rawOutput" } },
          { name: "code", value: "", source: { kind: "exitCode" } },
        ],
      },
    };
    // The node's input (manual sample "80") drives the rawOutput value.
    renderModal(node, { manualInput: "80" });
    // The result column heading is the data-vars title…
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.dataVarsTitle")),
    ).toBeTruthy();
    // …a manual value renders verbatim…
    expect(screen.getByText("host")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    // …a rawOutput value resolves to the input value (req 1), NOT a
    // placeholder. The var-val span shows "80" (the textarea also shows it as
    // the input, hence the explicit class query to disambiguate).
    const vals = screen
      .getAllByText("80")
      .filter((el) => el.className.includes("wf-node-modal__var-val"));
    expect(vals).toHaveLength(1);
    // …and a run-time-only source still shows a placeholder.
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.dataVarSource.exitCode")),
    ).toBeTruthy();
    // …and there is NO result textarea for a data node.
    expect(
      screen.queryByLabelText(i18n.t("editor.inspector.preview.resultTitle")),
    ).toBeNull();
  });

  it("renders the text-node editor with a textarea, hint, and value", () => {
    const node: WorkflowFlowNode = {
      id: "t1",
      type: "text",
      position: { x: 0, y: 0 },
      data: { kind: "text", text: "Hello ${name}" },
    };
    const { onNodeDataChange } = renderModal(node);
    const textarea = screen.getByPlaceholderText(
      i18n.t("editor.inspector.text.placeholder"),
    ) as HTMLTextAreaElement;
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.value).toBe("Hello ${name}");
    // The variable-insertion hint is shown so the user discovers the feature.
    expect(
      screen.getByText(i18n.t("editor.inspector.text.hint")),
    ).toBeTruthy();
    // Editing reports the new text.
    fireEvent.change(textarea, { target: { value: "Bye" } });
    expect(onNodeDataChange).toHaveBeenCalledWith("t1", { text: "Bye" });
  });

  it("highlights an available variable reference in the text overlay", () => {
    // start → set(name) → txt. `${name}` is an available (known) variable, so
    // its reference is painted with the known (blue) class.
    const start: WorkflowFlowNode = {
      id: "s",
      type: "start",
      position: { x: 0, y: 0 },
      data: { kind: "start" },
    };
    const set: WorkflowFlowNode = {
      id: "set",
      type: "data",
      position: { x: 0, y: 0 },
      data: {
        kind: "data",
        data: [
          { name: "name", value: "x", source: { kind: "manual", value: "x" } },
        ],
      },
    };
    const txt: WorkflowFlowNode = {
      id: "txt",
      type: "text",
      position: { x: 0, y: 0 },
      data: { kind: "text", text: "Hi ${name} and ${nope}" },
    };
    renderModal(txt, {
      allNodes: [start, set, txt],
      edges: [
        { id: "e0", source: "s", target: "set" },
        { id: "e1", source: "set", target: "txt" },
      ],
    });
    const known = screen.getByText("${name}");
    expect(known.className).toContain("wf-text-editor__var--known");
    // An unavailable reference is flagged as unknown (danger), not known.
    const unknown = screen.getByText("${nope}");
    expect(unknown.className).toContain("wf-text-editor__var--unknown");
  });

  it("treats ${raw_input} as known and ${schema_input} per the predecessor schema", () => {
    // No schema predecessor: ${raw_input} is known, ${schema_input} is not.
    const txt: WorkflowFlowNode = {
      id: "txt",
      type: "text",
      position: { x: 0, y: 0 },
      data: { kind: "text", text: "${raw_input} ${schema_input}" },
    };
    const { unmount } = renderModal(txt, { allNodes: [txt], edges: [] });
    expect(screen.getByText("${raw_input}").className).toContain(
      "wf-text-editor__var--known",
    );
    expect(screen.getByText("${schema_input}").className).toContain(
      "wf-text-editor__var--unknown",
    );
    unmount();

    // With a schema-bearing command predecessor, ${schema_input} is known too.
    const pred: WorkflowFlowNode = {
      id: "p",
      type: "command",
      position: { x: 0, y: 0 },
      data: { kind: "command", commandId: "c1" },
    };
    const cmd = {
      id: "c1",
      name: "c1",
      script: "echo",
      shell: "bash",
      variables: [],
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      outputSchema: { pipeline: [{ parser: "regex", fields: [{ name: "f" }] }] },
    } as unknown as Command;
    render(
      <ContextMenuProvider>
        <NodeInspector
          node={txt}
          predecessor={pred}
          allNodes={[pred, txt]}
          edges={[]}
          commands={[cmd]}
          inputPreview={null}
          outputPreview={null}
          manualInput=""
          manualOutput=""
          isRunning={false}
          onManualInputChange={vi.fn()}
          onManualOutputChange={vi.fn()}
          onCommandChange={vi.fn()}
          onNodeDataChange={vi.fn()}
          onDelete={vi.fn()}
          onRunNode={vi.fn()}
          onClose={vi.fn()}
        />
      </ContextMenuProvider>,
    );
    expect(screen.getByText("${schema_input}").className).toContain(
      "wf-text-editor__var--known",
    );
  });

  it("renders the output-schema editor for a parser node", () => {
    renderModal(flowNode("parser", "p1"));
    // The parser node's hint plus the embedded schema editor's enable toggle
    // (the sample/preview section only appears once parsing is enabled).
    expect(
      screen.getByText(i18n.t("editor.inspector.hint.parser")),
    ).toBeTruthy();
    expect(
      screen.getByText(i18n.t("commandForm.outputSchema.enable")),
    ).toBeTruthy();
  });

  it("runs the node with the live input as seed", () => {
    const { onRunNode } = renderModal(flowNode("command"), {
      inputPreview: { text: "upstream stdout", truncated: false },
    });
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("editor.inspector.runNode") }),
    );
    expect(onRunNode).toHaveBeenCalledWith("n1", "upstream stdout");
  });

  it("seeds the run with null when the node has no input", () => {
    const { onRunNode } = renderModal(flowNode("command"));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("editor.inspector.runNode") }),
    );
    expect(onRunNode).toHaveBeenCalledWith("n1", null);
  });

  it("falls back to the manual input as seed", () => {
    const { onRunNode } = renderModal(flowNode("command"), {
      manualInput: "typed sample",
    });
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("editor.inspector.runNode") }),
    );
    expect(onRunNode).toHaveBeenCalledWith("n1", "typed sample");
  });

  it("disables the run action while a run is in flight", () => {
    renderModal(flowNode("command"), { isRunning: true });
    const btn = screen.getByRole("button", {
      name: i18n.t("editor.inspector.runNode"),
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("hides the run action on start and end nodes", () => {
    renderModal(flowNode("start", "n-start"));
    expect(
      screen.queryByRole("button", {
        name: i18n.t("editor.inspector.runNode"),
      }),
    ).toBeNull();
  });

  it("closes on the apply action", () => {
    const { onClose } = renderModal(flowNode("command"));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.apply") }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
