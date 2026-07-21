import type { ReactElement } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalRegion as TerminalRegionModel } from "../../types/terminal";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalView } from "./TerminalView";
import { useOpenTerminalTab } from "./useOpenTerminalTab";

interface TerminalRegionProps {
  region: TerminalRegionModel;
  /** Whether the OWNING TAB of the whole panel is visible — always true here
   *  (the Terminal panel has a single layout), forwarded to each tab's view. */
  visible: boolean;
}

/**
 * One region: its own tab strip (`TerminalTabs`) plus the bodies of all its
 * tabs (only the region's `activeTabId` shown, the rest hidden-but-mounted so
 * their PTYs and scrollback survive). Moving a tab INTO this region via
 * drag-and-drop is handled by the tab STRIP (`TerminalTabs`), which is the
 * natural drop target — a tab belongs to a strip, not to a terminal body.
 *
 * No visual highlight for the "active" region: every region already has its
 * own "+" button (`TerminalTabs`) that always targets that exact region, and
 * where the next keystroke lands is already obvious from xterm's own blinking
 * cursor — a border duplicated that signal without resolving any ambiguity.
 */
export function TerminalRegion({ region, visible }: TerminalRegionProps): ReactElement {
  const setActiveRegion = useTerminalStore((s) => s.setActiveRegion);
  const openTab = useOpenTerminalTab();

  return (
    <div className="terminal-region" onMouseDown={() => setActiveRegion(region.id)}>
      <TerminalTabs region={region} onNewTab={() => openTab(region.id)} />
      <div className="terminal-region__body">
        {region.tabIds.map((tabId) => (
          <TerminalView
            key={tabId}
            sessionId={tabId}
            visible={visible && tabId === region.activeTabId}
          />
        ))}
      </div>
    </div>
  );
}
