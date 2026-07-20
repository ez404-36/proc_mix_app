import { useEffect } from "react";
import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "../../stores/terminalStore";
import { useOpenTerminalTab } from "./useOpenTerminalTab";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalView } from "./TerminalView";

/**
 * Terminal-mode content of the console (`OutputPanel`): the tab strip plus
 * every open session's view (all mounted, only the active one visible — see
 * `TerminalView`). Auto-opens a first tab the very first time the console
 * ever enters Terminal mode with nothing open yet, mirroring a real
 * terminal app (you expect a shell prompt immediately) — the console
 * header's own "New terminal" button is what put the panel into Terminal
 * mode in the first place, so this is never a surprise auto-spawn on app
 * startup.
 *
 * This component is CONDITIONALLY rendered by `OutputPanel` (only while
 * `panelMode === "terminal"`), so it fully unmounts every time the user
 * switches back to "Runs" and remounts fresh on switching back to
 * "Terminal". The auto-open guard therefore lives in `terminalStore`
 * (`consumeAutoOpen`), not a component-local ref/state — a local guard
 * would reset on every such remount and re-open a tab even after the user
 * had deliberately closed every one.
 */
export function TerminalPanel(): ReactElement {
  const { sessionOrder, activeSessionId, consumeAutoOpen } = useTerminalStore(
    useShallow((s) => ({
      sessionOrder: s.sessionOrder,
      activeSessionId: s.activeSessionId,
      consumeAutoOpen: s.consumeAutoOpen,
    })),
  );
  const openNewTab = useOpenTerminalTab();

  // Only ever auto-open once for the entire app session (see doc comment
  // above); subsequent closes down to zero tabs, or remounts of this
  // component, must NOT auto-reopen.
  useEffect(() => {
    if (sessionOrder.length === 0 && consumeAutoOpen()) {
      openNewTab();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="terminal-panel">
      <TerminalTabs onNewTab={openNewTab} />
      <div className="terminal-panel__body">
        {sessionOrder.map((id) => (
          <TerminalView key={id} sessionId={id} visible={id === activeSessionId} />
        ))}
      </div>
    </div>
  );
}
