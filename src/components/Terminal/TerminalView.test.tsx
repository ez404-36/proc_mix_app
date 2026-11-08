import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";

const mocks = vi.hoisted(() => ({
  pasteFromClipboard: vi.fn(),
}));

vi.mock("./useTerminalSession", () => ({
  pasteFromClipboard: mocks.pasteFromClipboard,
  useTerminalSession: (
    _sessionId: string,
    _containerRef: unknown,
    termRef: { current: Terminal | null },
  ): void => {
    termRef.current = {
      hasSelection: () => true,
      getSelection: () => "terminal text",
      selectAll: () => {},
    } as unknown as Terminal;
  },
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { TerminalView } from "./TerminalView";

describe("TerminalView", () => {
  it("opens its own copy menu before xterm handles the right click", () => {
    render(
      <ContextMenuProvider>
        <TerminalView sessionId="session-1" visible />
      </ContextMenuProvider>,
    );
    const container = document.querySelector(".terminal-view");
    expect(container).not.toBeNull();

    const event = createEvent.contextMenu(container!);
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    fireEvent(container!, event);

    // TerminalView must stop propagation before xterm's inner listener can
    // move/select its hidden textarea: that native-menu preparation clears
    // the xterm selection on some WebKitGTK/keyboard-layout combinations.
    expect(stopPropagation).toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    const copyItem = screen.getByRole("menuitem", { name: "Copy" });
    expect(copyItem).toBeTruthy();
    expect(copyItem.getAttribute("aria-disabled")).toBeNull();
  });
});
