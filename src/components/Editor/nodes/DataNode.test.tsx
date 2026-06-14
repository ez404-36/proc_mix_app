import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub reactflow's Handle/Position so the node renders without a provider.
import { vi } from "vitest";
vi.mock("reactflow", () => ({
  Handle: () => <div />,
  Position: { Left: "left", Right: "right" },
}));

import type { ComponentProps } from "react";
import "../../../i18n";
import i18n from "../../../i18n";
import type { DataAssignment } from "../../../types";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { DataNode } from "./DataNode";

function renderCard(assignments: DataAssignment[] | undefined) {
  const data: WorkflowNodeData = { kind: "data", data: assignments };
  // NodeProps has many required fields; DataNode only reads `data`.
  const props = { data } as unknown as ComponentProps<typeof DataNode>;
  render(<DataNode {...props} />);
}

describe("DataNode card", () => {
  it("lists each assignment as $name = <source>", () => {
    renderCard([
      { name: "host", value: "x", source: { kind: "manual", value: "x" } },
      { name: "code", value: "", source: { kind: "exitCode" } },
    ]);
    // Keys are `$name`.
    expect(screen.getByText("$host")).toBeTruthy();
    expect(screen.getByText("$code")).toBeTruthy();
    // Manual → its literal; non-manual → the localized <source> placeholder.
    expect(screen.getByText("x")).toBeTruthy();
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.dataVarSource.exitCode")),
    ).toBeTruthy();
    // The old "N assignment(s)" summary is gone.
    expect(screen.queryByText(/assignment\(s\)/)).toBeNull();
  });

  it("shows an empty-state when there are no assignments", () => {
    renderCard([]);
    expect(screen.getByText(i18n.t("editor.nodes.dataEmpty"))).toBeTruthy();
  });
});
