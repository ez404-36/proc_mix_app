import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "../../i18n";
import i18n from "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { TextNodeEditor } from "./TextNodeEditor";

function open(value: string, hasSchemaInput = false) {
  const onChange = vi.fn();
  render(
    <ContextMenuProvider>
      <TextNodeEditor
        value={value}
        variableNames={[]}
        hasSchemaInput={hasSchemaInput}
        onChange={onChange}
      />
    </ContextMenuProvider>,
  );
  return onChange;
}

/** Open the right-click menu, hover the parent group, click a leaf by label. */
function pickFromMenu(parentLabel: string, leafLabel: string): void {
  const textarea = screen.getByPlaceholderText(
    i18n.t("editor.inspector.text.placeholder"),
  );
  fireEvent.contextMenu(textarea);
  const parent = screen.getByText(parentLabel);
  // Hovering the parent opens its submenu (matches the component's behaviour).
  fireEvent.mouseEnter(parent.closest('[role="menuitem"]') as Element);
  fireEvent.click(screen.getByText(leafLabel));
}

describe("TextNodeEditor — incoming-data insertion", () => {
  it("inserts ${raw_input} with NO trailing newline", () => {
    const onChange = open("");
    pickFromMenu(
      i18n.t("editor.inspector.text.incomingData"),
      i18n.t("editor.inspector.text.rawInput"),
    );
    expect(onChange).toHaveBeenCalled();
    const calls = onChange.mock.calls;
    const inserted = calls[calls.length - 1][0] as string;
    expect(inserted).toBe("${raw_input}");
    // Regression: the inserted snippet must not end with a newline.
    expect(inserted.endsWith("\n")).toBe(false);
  });

  it("inserts ${raw_input} at the caret inside existing text", () => {
    const onChange = open("a b");
    const textarea = screen.getByPlaceholderText(
      i18n.t("editor.inspector.text.placeholder"),
    ) as HTMLTextAreaElement;
    // Caret after "a " (index 2).
    textarea.setSelectionRange(2, 2);
    pickFromMenu(
      i18n.t("editor.inspector.text.incomingData"),
      i18n.t("editor.inspector.text.rawInput"),
    );
    const calls = onChange.mock.calls;
    expect(calls[calls.length - 1][0]).toBe("a ${raw_input}b");
  });
});
