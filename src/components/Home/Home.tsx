import { useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { deleteCommand as deleteCommandWithHistory } from "../../services/commandActions";
import { deleteWorkflow as deleteWorkflowWithHistory } from "../../services/workflowActions";
import { deleteMiniApp as deleteMiniAppWithHistory } from "../../services/miniappActions";
import { openMiniAppWindow } from "../../services/miniappWindow";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useMiniAppWindowStore } from "../../stores/miniappWindowStore";
import { useScheduleStore } from "../../stores/scheduleStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, MiniApp, Workflow } from "../../types";
import {
  getCommandDescription,
  getCommandName,
} from "../../utils/commandLabels";
import { getMiniAppDescription, getMiniAppName } from "../../utils/miniappLabels";
import { globalCommands } from "../../utils/commandFilters";
import { renderIcon } from "../../utils/iconRenderer";
import {
  checkCommandBlockers,
  checkWorkflowBlockers,
} from "../../utils/usageCheck";
import type { DeleteBlocker } from "../../utils/usageCheck";
import { triggerCommandRun } from "../../services/commandRunner";
import { triggerWorkflowRun } from "../../services/workflowRunner";
import { BlockedDeleteDialog } from "../BlockedDeleteDialog/BlockedDeleteDialog";
import { CommandView } from "../CommandView";
import { ConfirmDialog } from "../ConfirmDialog";
import { WorkflowView } from "../WorkflowView";
import { useContextMenu } from "../ContextMenu";
import { RunIcon, SpinnerIcon } from "../icons";
import type { ContextMenuEntry } from "../ContextMenu";
import type { TFunction } from "i18next";

function runCommand(cmd: Command): void {
  void triggerCommandRun(cmd);
}

function buildCommandRowMenuItems(
  cmd: Command,
  isFavorite: boolean,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: (id: string) => void;
    onEdit: () => void;
    onView: () => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => runCommand(cmd),
    },
    {
      id: "view",
      label: t("contextMenu.view"),
      onSelect: () => actions.onView(),
    },
    {
      id: "favorite",
      label: isFavorite
        ? t("contextMenu.favoriteRemove")
        : t("contextMenu.favoriteAdd"),
      onSelect: () => actions.onToggleFavorite(cmd.id),
    },
    {
      id: "copy-script",
      label: t("contextMenu.copyScript"),
      onSelect: () => {
        void navigator.clipboard.writeText(cmd.script).catch((err: unknown) => {
          console.warn("copy script failed", err);
        });
      },
    },
    { id: "div1", divider: true },
    {
      id: "edit",
      label: t("contextMenu.edit"),
      onSelect: () => actions.onEdit(),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(cmd.id),
    },
  ];
}

function CommandRow({ cmd }: { cmd: Command }): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const isFavorite = useCommandStore((s) => s.favorites.includes(cmd.id));
  const toggleFavorite = useCommandStore((s) => s.toggleFavorite);
  // History-aware delete — see Library.tsx for the rationale.
  const deleteCommand = deleteCommandWithHistory;
  // Editor navigation — mirrors Library's `handleEdit` so a Home command
  // card opens the same full-screen command editor view.
  const setView = useUIStore((s) => s.setView);
  const setCommandEditorTarget = useUIStore((s) => s.setCommandEditorTarget);
  const setCommandEditorDirty = useUIStore((s) => s.setCommandEditorDirty);
  const workflows = useWorkflowStore((s) => s.workflows);
  const schedules = useScheduleStore((s) => s.schedules);
  const displayName = getCommandName(cmd, t);
  const displayDesc = getCommandDescription(cmd, t);
  // Whether the delete-confirmation dialog is open for this row.
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  // Blockers preventing deletion (non-empty = show blocked dialog).
  const [deleteBlockers, setDeleteBlockers] = useState<DeleteBlocker[]>([]);
  // Whether the read-only view modal is open (opened by double-click).
  const [viewOpen, setViewOpen] = useState<boolean>(false);

  // Open the full-screen command editor for this command. Reset the dirty
  // flag first so a stale "dirty" from a previous session can't block the
  // navigation guard — same contract as Library.tsx:handleEdit.
  const handleEdit = (): void => {
    setCommandEditorDirty(false);
    setCommandEditorTarget({ mode: "edit", commandId: cmd.id });
    setView("command-editor");
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildCommandRowMenuItems(cmd, isFavorite, t, {
        onToggleFavorite: toggleFavorite,
        onDelete: requestDelete,
        onEdit: handleEdit,
        onView: () => setViewOpen(true),
      }),
    });
  };

  // Double-click opens the read-only view modal first — matches Library's
  // cards (a casual double-click inspects; editing is explicit via the
  // modal's Edit button or the context menu). The Run button stops
  // propagation so a quick double-click on it does not also open the view.
  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setViewOpen(true);
  };

  const requestDelete = (): void => {
    const blockers = checkCommandBlockers(cmd.id, workflows, schedules);
    setDeleteBlockers(blockers);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = (): void => {
    deleteCommand(cmd.id);
    setConfirmOpen(false);
    setDeleteBlockers([]);
  };

  return (
    <div
      className="list-tile list-tile--command"
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <div className="list-tile__head">
        <div>
          <h3 className="list-tile__title">{displayName}</h3>
          {displayDesc ? (
            <p className="list-tile__desc">{displayDesc}</p>
          ) : null}
        </div>
      </div>
      <div className="list-tile__meta">
        <span className="type-badge type-badge--command">{t("home.typeCommand")}</span>
      </div>
      <div className="list-tile__actions">
        <button
          type="button"
          className="btn btn--run"
          onClick={() => runCommand(cmd)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <RunIcon />
          {t("common.run")}
        </button>
      </div>

      {confirmOpen && deleteBlockers.length > 0 ? (
        <BlockedDeleteDialog
          objectName={displayName}
          blockers={deleteBlockers}
          onClose={() => {
            setConfirmOpen(false);
            setDeleteBlockers([]);
          }}
        />
      ) : (
        <ConfirmDialog
          open={confirmOpen}
          title={t("library.deleteConfirmTitle")}
          message={t("library.deleteConfirm", { name: displayName })}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      <CommandView
        command={viewOpen ? cmd : null}
        onClose={() => setViewOpen(false)}
        onEdit={() => {
          setViewOpen(false);
          handleEdit();
        }}
        onRun={(c) => {
          setViewOpen(false);
          runCommand(c);
        }}
        onDelete={() => {
          setViewOpen(false);
          requestDelete();
        }}
      />
    </div>
  );
}

function buildWorkflowRowMenuItems(
  wf: Workflow,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: () => void;
    onEdit: () => void;
    onView: () => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => {
        void triggerWorkflowRun(wf);
      },
    },
    {
      id: "view",
      label: t("contextMenu.view"),
      onSelect: () => actions.onView(),
    },
    {
      id: "favorite",
      label: wf.favorite
        ? t("contextMenu.favoriteRemove")
        : t("contextMenu.favoriteAdd"),
      onSelect: () => actions.onToggleFavorite(wf.id),
    },
    { id: "div1", divider: true },
    {
      id: "edit",
      label: t("contextMenu.edit"),
      onSelect: () => actions.onEdit(),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(),
    },
  ];
}

function WorkflowRow({ wf }: { wf: Workflow }): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const toggleFavorite = useWorkflowStore((s) => s.toggleFavorite);
  // History-aware delete — routes through `workflowActions` so a
  // `workflowDeleted` event is logged for the History view's restore flow.
  const deleteWorkflow = deleteWorkflowWithHistory;
  // Editor navigation — mirrors Library's workflow `handleEdit`.
  const setView = useUIStore((s) => s.setView);
  const setEditorWorkflowId = useUIStore((s) => s.setEditorWorkflowId);
  const schedules = useScheduleStore((s) => s.schedules);
  // Whether the delete-confirmation dialog is open for this row.
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  // Blockers preventing deletion (non-empty = show blocked dialog).
  const [deleteBlockers, setDeleteBlockers] = useState<DeleteBlocker[]>([]);
  // Whether the read-only view modal is open (opened by double-click).
  const [viewOpen, setViewOpen] = useState<boolean>(false);

  // Open the workflow editor for this workflow.
  const handleEdit = (): void => {
    setEditorWorkflowId(wf.id);
    setView("editor");
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildWorkflowRowMenuItems(wf, t, {
        onToggleFavorite: toggleFavorite,
        onDelete: requestDelete,
        onEdit: handleEdit,
        onView: () => setViewOpen(true),
      }),
    });
  };

  // Double-click opens the read-only view modal first — matches Library's
  // workflow cards (a casual double-click inspects; editing is explicit via
  // the modal's Edit button or the context menu). The Run button stops
  // propagation so a quick double-click on it does not also open the view.
  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setViewOpen(true);
  };

  const requestDelete = (): void => {
    const blockers = checkWorkflowBlockers(wf.id, schedules);
    setDeleteBlockers(blockers);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = (): void => {
    deleteWorkflow(wf.id);
    setConfirmOpen(false);
    setDeleteBlockers([]);
  };

  return (
    <div
      className="list-tile list-tile--workflow"
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <div className="list-tile__head">
        <div>
          <h3 className="list-tile__title">{wf.name}</h3>
          {wf.description ? (
            <p className="list-tile__desc">{wf.description}</p>
          ) : null}
        </div>
      </div>
      <div className="list-tile__meta">
        <span className="type-badge type-badge--workflow">{t("home.typeWorkflow")}</span>
      </div>
      <div className="list-tile__actions">
        <button
          type="button"
          className="btn btn--run"
          onClick={() => {
            void triggerWorkflowRun(wf);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <RunIcon />
          {t("common.run")}
        </button>
      </div>

      {confirmOpen && deleteBlockers.length > 0 ? (
        <BlockedDeleteDialog
          objectName={wf.name}
          blockers={deleteBlockers}
          onClose={() => {
            setConfirmOpen(false);
            setDeleteBlockers([]);
          }}
        />
      ) : (
        <ConfirmDialog
          open={confirmOpen}
          title={t("workflow.deleteConfirmTitle")}
          message={t("workflow.deleteConfirm", { name: wf.name })}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      <WorkflowView
        workflow={viewOpen ? wf : null}
        onClose={() => setViewOpen(false)}
        onEdit={() => {
          setViewOpen(false);
          handleEdit();
        }}
        onRun={(w) => {
          setViewOpen(false);
          void triggerWorkflowRun(w);
        }}
        onDelete={() => {
          setViewOpen(false);
          requestDelete();
        }}
      />
    </div>
  );
}

function buildMiniAppRowMenuItems(
  miniapp: MiniApp,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: () => void;
    onEdit: () => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "favorite",
      label: miniapp.favorite
        ? t("contextMenu.favoriteRemove")
        : t("contextMenu.favoriteAdd"),
      onSelect: () => actions.onToggleFavorite(miniapp.id),
    },
    { id: "div1", divider: true },
    {
      id: "edit",
      label: t("contextMenu.edit"),
      onSelect: () => actions.onEdit(),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(),
    },
  ];
}

/**
 * Favorite mini-app row. Mini-apps run in their own OS window (not an
 * in-app view) — see `services/miniappWindow.ts` — so, unlike
 * `CommandRow`/`WorkflowRow`, there is no read-only view modal here;
 * double-click opens the editor directly, mirroring the Library's
 * `MiniAppCard` double-click-less contract (that card has no
 * `onDoubleClick` either — its title area alone opens the editor).
 */
function MiniAppRow({ miniapp }: { miniapp: MiniApp }): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const toggleFavorite = useMiniAppStore((s) => s.toggleFavorite);
  // History-aware delete — see Library.tsx for the rationale.
  const deleteMiniApp = deleteMiniAppWithHistory;
  const setView = useUIStore((s) => s.setView);
  const setMiniappEditorId = useUIStore((s) => s.setMiniappEditorId);
  const isRunning = useMiniAppWindowStore((s) => s.runningIds.has(miniapp.id));
  const displayName = getMiniAppName(miniapp, t);
  const displayDesc = getMiniAppDescription(miniapp, t);
  // Whether the delete-confirmation dialog is open for this row.
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);

  const handleEdit = (): void => {
    setMiniappEditorId(miniapp.id);
    setView("miniapp-editor");
  };

  const handleRun = (): void => {
    // Mirrors the Library's `MiniAppCard` Run handler — skip the IPC call
    // for an already-running mini-app; the Rust side would just focus the
    // existing window (never a duplicate), but this keeps every entry
    // point from even attempting a pointless second round-trip.
    if (isRunning) return;
    openMiniAppWindow(miniapp.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(
        t("miniapps.windowOpenFailed", { defaultValue: message, message }),
      );
    });
  };

  const requestDelete = (): void => {
    setConfirmOpen(true);
  };

  const handleConfirmDelete = (): void => {
    deleteMiniApp(miniapp.id);
    setConfirmOpen(false);
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildMiniAppRowMenuItems(miniapp, t, {
        onToggleFavorite: toggleFavorite,
        onDelete: requestDelete,
        onEdit: handleEdit,
      }),
    });
  };

  return (
    <div
      className="list-tile list-tile--miniapp"
      onContextMenu={handleContextMenu}
      onDoubleClick={handleEdit}
    >
      <div className="list-tile__head">
        <div>
          <h3 className="list-tile__title">
            {renderIcon(miniapp.icon, 20, "list-tile__icon")}
            {displayName}
          </h3>
          {displayDesc ? <p className="list-tile__desc">{displayDesc}</p> : null}
        </div>
      </div>
      <div className="list-tile__meta">
        <span className="type-badge type-badge--miniapp">{t("home.typeMiniApp")}</span>
      </div>
      <div className="list-tile__actions">
        <button
          type="button"
          className={`btn btn--run${isRunning ? " is-running" : ""}`}
          onClick={handleRun}
          onDoubleClick={(e) => e.stopPropagation()}
          disabled={isRunning}
        >
          {isRunning ? <SpinnerIcon /> : <RunIcon />}
          {isRunning ? t("miniapps.running") : t("common.run")}
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t("miniapps.deleteConfirmTitle")}
        message={t("miniapps.deleteConfirm", { name: displayName })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** A recently-run entry, discriminated so the list can render either kind. */
type RecentEntry =
  | { type: "command"; lastRunAt: string; command: Command }
  | { type: "workflow"; lastRunAt: string; workflow: Workflow };

export function Home(): ReactElement {
  const { t } = useTranslation();
  const allCommands = useCommandStore((s) => s.commands);
  const commands = useMemo(() => globalCommands(allCommands), [allCommands]);
  const workflows = useWorkflowStore((s) => s.workflows);
  const miniapps = useMiniAppStore((s) => s.miniapps);

  type FavoriteEntry =
    | { type: "command"; command: Command }
    | { type: "workflow"; workflow: Workflow }
    | { type: "miniapp"; miniapp: MiniApp };

  const favorites = useMemo<FavoriteEntry[]>(
    () => [
      ...commands.filter((c) => c.favorite).map((c) => ({ type: "command" as const, command: c })),
      ...workflows.filter((w) => w.favorite).map((w) => ({ type: "workflow" as const, workflow: w })),
      ...miniapps.filter((m) => m.favorite).map((m) => ({ type: "miniapp" as const, miniapp: m })),
    ],
    [commands, workflows, miniapps],
  );

  const recent = useMemo<RecentEntry[]>(() => {
    const commandEntries: RecentEntry[] = commands
      .filter((c) => c.lastRunAt !== undefined)
      .map((c) => ({
        type: "command",
        lastRunAt: c.lastRunAt ?? "",
        command: c,
      }));
    const workflowEntries: RecentEntry[] = workflows
      .filter((w) => w.lastRunAt !== undefined)
      .map((w) => ({
        type: "workflow",
        lastRunAt: w.lastRunAt ?? "",
        workflow: w,
      }));
    return [...commandEntries, ...workflowEntries]
      .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt))
      .slice(0, 5);
  }, [commands, workflows]);

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("home.title")}</h1>
          <p className="view-subtitle">{t("home.subtitle")}</p>
        </div>
      </header>

      <section className="view-section">
        <h2 className="view-section__title">{t("home.favoritesSection")}</h2>
        {favorites.length === 0 ? (
          <div className="empty-state">{t("home.noFavorites")}</div>
        ) : (
          <div className="command-list">
            {favorites.map((entry) => {
              if (entry.type === "command") {
                return <CommandRow key={`cmd-${entry.command.id}`} cmd={entry.command} />;
              }
              if (entry.type === "workflow") {
                return <WorkflowRow key={`wf-${entry.workflow.id}`} wf={entry.workflow} />;
              }
              return <MiniAppRow key={`ma-${entry.miniapp.id}`} miniapp={entry.miniapp} />;
            })}
          </div>
        )}
      </section>

      <section className="view-section">
        <h2 className="view-section__title">{t("home.recentSection")}</h2>
        {recent.length === 0 ? (
          <div className="empty-state">{t("home.noRecent")}</div>
        ) : (
          <div className="command-list">
            {recent.map((entry) =>
              entry.type === "command" ? (
                <CommandRow
                  key={`cmd-${entry.command.id}`}
                  cmd={entry.command}
                />
              ) : (
                <WorkflowRow
                  key={`wf-${entry.workflow.id}`}
                  wf={entry.workflow}
                />
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
