import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@xyflow/react", () => ({
  Handle: () => <div />,
  Position: { Left: "left", Right: "right" },
}));

import "../../../i18n";
import i18n from "../../../i18n";
import type { DataSource } from "../../../types";
import { VariableSourceList } from "./VariableSourceList";

describe("VariableSourceList", () => {
  it("lists each bound variable as $name = <source>", () => {
    const sources: Record<string, DataSource> = {
      host: { kind: "manual", value: "example.com" },
      code: { kind: "exitCode" },
    };
    render(<VariableSourceList variableSources={sources} />);
    expect(screen.getByText("$host")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("$code")).toBeTruthy();
    expect(
      screen.getByText(i18n.t("editor.inspector.preview.dataVarSource.exitCode")),
    ).toBeTruthy();
  });

  it("renders nothing when no variable is bound", () => {
    const { container } = render(
      <VariableSourceList variableSources={undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("ignores entries with an empty name", () => {
    const { container } = render(
      <VariableSourceList
        variableSources={{ "  ": { kind: "rawOutput" } }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
