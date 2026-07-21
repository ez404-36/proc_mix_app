import { useEffect } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "../../stores/terminalStore";
import { TerminalIcon } from "../icons";
import { useOpenTerminalTab } from "./useOpenTerminalTab";
import { RegionLayout } from "./RegionLayout";

/**
 * Terminal-mode content of the console (`OutputPanel`): the region layout
 * (`RegionLayout`) — one or more regions, each with its own tab strip. Every
 * tab's xterm stays mounted (hidden when its region shows another tab) so
 * PTYs and scrollback survive. Auto-opens a first tab the very first time the
 * console ever enters Terminal mode with nothing open yet, mirroring a real
 * terminal app.
 *
 * This component is CONDITIONALLY rendered by `OutputPanel` (only while
 * `panelMode === "terminal"`), so it fully unmounts when the user switches
 * back to "Runs" and remounts fresh on switching back. The auto-open guard
 * therefore lives in `terminalStore` (`consumeAutoOpen`), not a
 * component-local ref — a local guard would reset on every such remount and
 * re-open a tab even after the user had deliberately closed every one.
 */
export function TerminalPanel(): ReactElement {
  const { t } = useTranslation();
  const { layoutRoot, consumeAutoOpen } = useTerminalStore(
    useShallow((s) => ({
      layoutRoot: s.layoutRoot,
      consumeAutoOpen: s.consumeAutoOpen,
    })),
  );
  const openNewTab = useOpenTerminalTab();

  // Only ever auto-open once for the entire app session; subsequent closes
  // down to zero tabs, or remounts of this component, must NOT auto-reopen.
  useEffect(() => {
    if (!layoutRoot && consumeAutoOpen()) {
      openNewTab();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        {layoutRoot ? (
          <RegionLayout node={layoutRoot} />
        ) : (
          // Every tab was closed (the auto-open guard is spent, so nothing
          // re-opens on its own). Offer an explicit way back in — otherwise
          // the panel is empty with no tab strip and no "+".
          <div className="terminal-panel__empty">
            <p className="empty-state">
              {t("outputPanel.terminal.emptyHint", {
                defaultValue: "No open terminals.",
              })}
            </p>
            <button type="button" className="btn btn--primary" onClick={() => openNewTab()}>
              <TerminalIcon />
              {t("outputPanel.terminal.newTab", { defaultValue: "New terminal" })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
