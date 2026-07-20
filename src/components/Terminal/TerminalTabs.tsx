import { useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import {
  closeTerminalSession,
  forgetTerminalSession,
} from "../../services/terminalService";
import { useTerminalStore } from "../../stores/terminalStore";
import { CancelIcon, EditIcon, PlusIcon } from "../icons";

interface TerminalTabsProps {
  onNewTab: () => void;
}

/**
 * Tab strip for open terminal sessions. Its own class family
 * (`terminal-tabs` / `terminal-tab`), not `output-panel__tabs` — that one
 * toggles between the Output/Result view of a SINGLE run and lives at a
 * different level (inside the "Runs" mode), while this strip switches
 * between independent PTY sessions in "Terminal" mode.
 *
 * Renaming mirrors the recents-strip pattern in `OutputPanel` (inline
 * `<input>` replacing the label, committed on Enter/blur, cancelled on
 * Escape) — reachable via double-click on the tab title OR the tab's
 * right-click context menu, matching a real terminal emulator's tab UX.
 */
export function TerminalTabs({ onNewTab }: TerminalTabsProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const {
    sessions,
    sessionOrder,
    activeSessionId,
    setActiveSession,
    closeSession,
    renameSession,
  } = useTerminalStore(
    useShallow((s) => ({
      sessions: s.sessions,
      sessionOrder: s.sessionOrder,
      activeSessionId: s.activeSessionId,
      setActiveSession: s.setActiveSession,
      closeSession: s.closeSession,
      renameSession: s.renameSession,
    })),
  );

  // The tab currently being renamed inline (its session id), plus the live
  // text. `null` = no rename in progress. Commit on Enter/blur, cancel on
  // Escape — same contract as `OutputPanel`'s recents-strip rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");

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
    // The tab is gone for good now (not a StrictMode remount) — safe to
    // drop its buffered events/handler bookkeeping in `terminalService`.
    forgetTerminalSession(id);
  };

  const buildTabMenu = (id: string, title: string): ContextMenuEntry[] => [
    {
      id: "rename",
      label: t("outputPanel.terminal.rename", { defaultValue: "Rename" }),
      icon: <EditIcon />,
      onSelect: () => beginRename(id, title),
    },
    { id: "div1", divider: true },
    {
      id: "close",
      label: t("outputPanel.terminal.closeTab", { defaultValue: "Close terminal" }),
      icon: <CancelIcon />,
      danger: true,
      onSelect: () => handleClose(id),
    },
  ];

  return (
    <div className="terminal-tabs" role="tablist">
      {sessionOrder.map((id) => {
        const session = sessions[id];
        if (!session) return null;
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
            aria-selected={activeSessionId === id}
            className={`terminal-tab${activeSessionId === id ? " is-active" : ""}${
              session.exited ? " terminal-tab--exited" : ""
            }`}
            onClick={() => setActiveSession(id)}
            onContextMenu={(e) =>
              show({
                event: {
                  clientX: e.clientX,
                  clientY: e.clientY,
                  preventDefault: () => e.preventDefault(),
                },
                items: buildTabMenu(id, session.title),
              })
            }
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
        title={t("outputPanel.terminal.newTab", { defaultValue: "New terminal" })}
        aria-label={t("outputPanel.terminal.newTab", {
          defaultValue: "New terminal",
        })}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
