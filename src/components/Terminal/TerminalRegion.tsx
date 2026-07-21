import type { ReactElement } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalRegion as TerminalRegionModel } from "../../types/terminal";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalView } from "./TerminalView";
import { useOpenTerminalTab } from "./useOpenTerminalTab";

interface TerminalRegionProps {
  region: TerminalRegionModel;
  /** Whether this region is the active (focused) one — drives the highlight. */
  active: boolean;
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
 */
export function TerminalRegion({ region, active, visible }: TerminalRegionProps): ReactElement {
  const setActiveRegion = useTerminalStore((s) => s.setActiveRegion);
  const openTab = useOpenTerminalTab();

  return (
    <div
      className={`terminal-region${active ? " is-active" : ""}`}
      onMouseDown={() => setActiveRegion(region.id)}
    >
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
