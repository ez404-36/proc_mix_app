import { useState } from "react";
import type { DragEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import {
  MAX_TERMINAL_SESSIONS,
  closeTerminalSession,
  forgetTerminalSession,
} from "../../services/terminalService";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalRegion } from "../../types/terminal";
import { findAdjacentRegion } from "../../utils/regionTree";
import type { RegionSide } from "../../utils/regionTree";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CancelIcon,
  EditIcon,
  PlusIcon,
  SplitColumnIcon,
  SplitRowIcon,
} from "../icons";
import { TERMINAL_TAB_DND_TYPE } from "./terminalDnd";

interface TerminalTabsProps {
  /** The region this strip belongs to. */
  region: TerminalRegion;
  /** Open a new tab in THIS region (the region's "+" button). */
  onNewTab: () => void;
}

/**
 * Tab strip for a single REGION (one rectangular area of the Terminal panel).
 * Its own class family (`terminal-tabs` / `terminal-tab`), not
 * `output-panel__tabs`. Each region has its own strip; switching tabs here
 * only affects this region.
 *
 * Per-tab interactions:
 * - click → make active tab of the region;
 * - double-click title / right-click → "Rename" (inline `<input>`, Enter/blur
 *   commits, Escape cancels — same contract as `OutputPanel`'s recents strip);
 * - right-click → "Move right" / "Move down" (peel the tab into a new region
 *   beside this one — DISABLED when this is the region's only tab, since a
 *   lone tab has nowhere to move) and "Close terminal";
 * - drag → move the tab onto another region (see `TerminalRegion` drop zone).
 */
export function TerminalTabs({ region, onNewTab }: TerminalTabsProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const sessions = useTerminalStore((s) => s.sessions);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const closeSession = useTerminalStore((s) => s.closeSession);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const moveTabToNewRegion = useTerminalStore((s) => s.moveTabToNewRegion);
  const moveTabToRegion = useTerminalStore((s) => s.moveTabToRegion);
  const moveTabToAdjacentRegion = useTerminalStore((s) => s.moveTabToAdjacentRegion);
  const layoutRoot = useTerminalStore((s) => s.layoutRoot);
  // One session per open tab, across all regions — the same thing the backend
  // caps. At the cap, opening another would just hit the backend error, so
  // disable the "+" and say why (the backend stays the real enforcer).
  const sessionCount = useTerminalStore((s) => Object.keys(s.sessions).length);
  const atCapacity = sessionCount >= MAX_TERMINAL_SESSIONS;

  // The tab currently being renamed inline (its session id), plus the live
  // text. `null` = no rename in progress.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  // Whether a tab is currently being dragged over this strip (drop highlight).
  const [dropActive, setDropActive] = useState(false);

  const beginRename = (id: string, currentTitle: string): void => {
    setRenamingId(id);
    setRenameDraft(currentTitle);
  };
  const commitRename = (): void => {
    if (renamingId !== null) {
      renameSession(renamingId, renameDraft);
    }
    setRenamingId(null);
    setRenameDraft("");
  };
  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameDraft("");
  };

  const handleClose = (id: string): void => {
    void closeTerminalSession(id);
    closeSession(id);
    // The tab is gone for good now (not a StrictMode remount) — safe to drop
    // its buffered events/handler bookkeeping in `terminalService`.
    forgetTerminalSession(id);
  };

  // A tab can only be peeled into a NEW region if it has a sibling to stay
  // behind — otherwise moving it would leave its region empty (i.e. it would
  // move into a copy of itself). Matches `moveTabToNewRegion`'s own guard.
  const canPeel = region.tabIds.length > 1;

  // Whether an EXISTING region exists in each direction from this one. A move
  // into a neighbour is otherwise disabled (there's nowhere to move to).
  const hasNeighbour = (side: RegionSide): boolean =>
    layoutRoot !== null && findAdjacentRegion(layoutRoot, region.id, side) !== null;

  const buildTabMenu = (id: string, title: string): ContextMenuEntry[] => [
    {
      id: "rename",
      label: t("outputPanel.terminal.rename", { defaultValue: "Rename" }),
      icon: <EditIcon />,
      onSelect: () => beginRename(id, title),
    },
    { id: "div1", divider: true },
    {
      id: "new-region-right",
      label: t("outputPanel.terminal.newRegionRight", { defaultValue: "New region right" }),
      icon: <SplitColumnIcon />,
      disabled: !canPeel,
      onSelect: () => moveTabToNewRegion(id, "row"),
    },
    {
      id: "new-region-down",
      label: t("outputPanel.terminal.newRegionDown", { defaultValue: "New region below" }),
      icon: <SplitRowIcon />,
      disabled: !canPeel,
      onSelect: () => moveTabToNewRegion(id, "column"),
    },
    { id: "div2", divider: true },
    {
      id: "move-left",
      label: t("outputPanel.terminal.moveLeft", { defaultValue: "Move left" }),
      icon: <ArrowLeftIcon />,
      disabled: !hasNeighbour("left"),
      onSelect: () => moveTabToAdjacentRegion(id, "left"),
    },
    {
      id: "move-right",
      label: t("outputPanel.terminal.moveRight", { defaultValue: "Move right" }),
      icon: <ArrowRightIcon />,
      disabled: !hasNeighbour("right"),
      onSelect: () => moveTabToAdjacentRegion(id, "right"),
    },
    {
      id: "move-up",
      label: t("outputPanel.terminal.moveUp", { defaultValue: "Move up" }),
      icon: <ArrowUpIcon />,
      disabled: !hasNeighbour("up"),
      onSelect: () => moveTabToAdjacentRegion(id, "up"),
    },
    {
      id: "move-down",
      label: t("outputPanel.terminal.moveDown", { defaultValue: "Move down" }),
      icon: <ArrowDownIcon />,
      disabled: !hasNeighbour("down"),
      onSelect: () => moveTabToAdjacentRegion(id, "down"),
    },
    { id: "div3", divider: true },
    {
      id: "close",
      label: t("outputPanel.terminal.closeTab", { defaultValue: "Close terminal" }),
      icon: <CancelIcon />,
      danger: true,
      onSelect: () => handleClose(id),
    },
  ];

  const handleDragStart = (event: DragEvent<HTMLDivElement>, id: string): void => {
    event.dataTransfer.setData(TERMINAL_TAB_DND_TYPE, id);
    event.dataTransfer.effectAllowed = "move";
  };

  const isTabDrag = (event: DragEvent<HTMLDivElement>): boolean =>
    event.dataTransfer.types.includes(TERMINAL_TAB_DND_TYPE);

  // The STRIP is the drop target — a tab belongs to a tab strip, so dropping
  // one here moves it into this region (`moveTabToRegion` is a no-op if it is
  // already this region's sole tab).
  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!isTabDrag(event)) return;
    event.preventDefault(); // allow the drop
    event.dataTransfer.dropEffect = "move";
    if (!dropActive) setDropActive(true);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!isTabDrag(event)) return;
    event.preventDefault();
    setDropActive(false);
    const tabId = event.dataTransfer.getData(TERMINAL_TAB_DND_TYPE);
    if (tabId) moveTabToRegion(tabId, region.id);
  };

  return (
    <div
      className={`terminal-tabs${dropActive ? " terminal-tabs--drop" : ""}`}
      role="tablist"
      onDragOver={handleDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      {region.tabIds.map((id) => {
        const session = sessions[id];
        if (!session) return null;
        const isActive = region.activeTabId === id;
        if (renamingId === id) {
          return (
            <input
              key={id}
              type="text"
              className="input terminal-tab__rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              aria-label={t("outputPanel.terminal.rename", { defaultValue: "Rename" })}
            />
          );
        }
        return (
          <div
            key={id}
            role="tab"
            draggable
            aria-selected={isActive}
            className={`terminal-tab${isActive ? " is-active" : ""}${
              session.exited ? " terminal-tab--exited" : ""
            }`}
            onClick={() => setActiveTab(id)}
            onDragStart={(e) => handleDragStart(e, id)}
            onContextMenu={(e) => {
              e.preventDefault();
              show({
                event: {
                  clientX: e.clientX,
                  clientY: e.clientY,
                  preventDefault: () => e.preventDefault(),
                },
                items: buildTabMenu(id, session.title),
              });
            }}
          >
            <span
              className="terminal-tab__title"
              title={session.title}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginRename(id, session.title);
              }}
            >
              {session.title}
            </span>
            <button
              type="button"
              className="terminal-tab__close"
              aria-label={t("outputPanel.terminal.closeTab", {
                defaultValue: "Close terminal",
              })}
              onClick={(e) => {
                e.stopPropagation();
                handleClose(id);
              }}
            >
              <CancelIcon />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="terminal-tabs__new"
        onClick={onNewTab}
        disabled={atCapacity}
        title={
          atCapacity
            ? t("outputPanel.terminal.capacityReached", {
                defaultValue: "Maximum number of terminals reached ({{max}})",
                max: MAX_TERMINAL_SESSIONS,
              })
            : t("outputPanel.terminal.newTab", { defaultValue: "New terminal" })
        }
        aria-label={t("outputPanel.terminal.newTab", {
          defaultValue: "New terminal",
        })}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
