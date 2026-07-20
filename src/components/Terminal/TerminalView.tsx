import { useRef } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Terminal } from "@xterm/xterm";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { CopyIcon, PasteIcon } from "../icons";
import { pasteFromClipboard, useTerminalSession } from "./useTerminalSession";

interface TerminalViewProps {
  sessionId: string;
  /** Hidden (not unmounted) when a different tab is active, so the xterm.js
   *  instance and its scrollback survive tab switches. */
  visible: boolean;
}

/**
 * Hosts a single xterm.js terminal for one PTY session. Kept mounted for
 * the lifetime of the tab (see `visible`) rather than unmounted on tab
 * switch, so the backend PTY keeps running and its scrollback is preserved
 * exactly like a real terminal emulator's tabs.
 *
 * Clipboard: `Ctrl`/`Cmd`+`V` is handled by `useTerminalSession`'s own
 * `attachCustomKeyEventHandler` (layout-independent, see its doc comment),
 * not the browser's native paste event. This component ADDITIONALLY
 * exposes Copy / Paste / Select all as a right-click context menu — the
 * same affordance every other text surface in the app offers
 * (`buildConsoleCopyMenu`, `ScriptEditor`'s edit menu) — for users who
 * prefer the mouse.
 */
export function TerminalView({
  sessionId,
  visible,
}: TerminalViewProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  useTerminalSession(sessionId, containerRef, termRef);

  const buildMenu = (): ContextMenuEntry[] => {
    const term = termRef.current;
    const hasSelection = term?.hasSelection() ?? false;
    return [
      {
        id: "copy",
        label: t("contextMenu.copy"),
        icon: <CopyIcon />,
        disabled: !hasSelection,
        onSelect: () => {
          const selection = term?.getSelection() ?? "";
          if (selection.length > 0) {
            void navigator.clipboard.writeText(selection).catch((err: unknown) => {
              console.warn("copy terminal selection failed", err);
            });
          }
        },
      },
      {
        id: "paste",
        label: t("contextMenu.paste"),
        icon: <PasteIcon />,
        onSelect: () => {
          if (term) pasteFromClipboard(term);
        },
      },
      { id: "div1", divider: true },
      {
        id: "select-all",
        label: t("contextMenu.selectAll"),
        onSelect: () => term?.selectAll(),
      },
    ];
  };

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ display: visible ? "block" : "none" }}
      role="tabpanel"
      onContextMenu={(e) => {
        e.preventDefault();
        show({
          event: {
            clientX: e.clientX,
            clientY: e.clientY,
            preventDefault: () => e.preventDefault(),
          },
          items: buildMenu(),
        });
      }}
    />
  );
}
