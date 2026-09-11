import { useEffect, useMemo, useState } from "react";
import type {
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Message } from "@arco-design/web-react";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import {
  MAX_TERMINAL_SESSIONS,
  describeTerminalSession,
} from "../../services/terminalService";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import { PromptModal } from "../PromptModal/PromptModal";
import {
  ChevronIcon,
  EditIcon,
  SaveIcon,
  TrashIcon,
} from "../icons";
import { useExecutionStore } from "../../stores/executionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminalLayoutsStore } from "../../stores/terminalLayoutsStore";
import { useUIStore } from "../../stores/uiStore";
import type {
  TerminalLayoutDto,
  TerminalLayoutState,
  TerminalSessionDescription,
} from "../../types/terminalLayout";
import {
  countSpecTabs,
  snapshotFromState,
  terminalLayoutStateEquals,
} from "../../utils/terminalLayoutSnapshot";
import { useApplyTerminalLayout } from "./useApplyTerminalLayout";

/**
 * The terminal-layout ("макеты терминала") picker in the console header,
 * shown right of the Запуски/Терминал mode toggle while Terminal mode is
 * active. A compact dropdown lists the saved layouts (applying one restores
 * the display variant + windows and re-runs each saved window's command),
 * next to a small "manage" button opening Save as / Update / Rename / Delete.
 *
 * All persistence goes through `terminalLayoutsStore` (SQLite-backed); all
 * state reads are store subscriptions so the dirty marker ("•" after the
 * name of the layout that no longer matches the console) stays live.
 */
export function TerminalLayoutPicker(): ReactElement {
  const { t } = useTranslation();
  const applyLayout = useApplyTerminalLayout();
  const { show } = useContextMenu();

  const { layouts, activeLayoutId, load } = useTerminalLayoutsStore(
    useShallow((s) => ({
      layouts: s.layouts,
      activeLayoutId: s.activeLayoutId,
      load: s.load,
    })),
  );
  const { layoutRoot, regions, sessions, lastCommands } = useTerminalStore(
    useShallow((s) => ({
      layoutRoot: s.layoutRoot,
      regions: s.regions,
      sessions: s.sessions,
      lastCommands: s.lastCommands,
    })),
  );
  const consolePosition = useUIStore((s) => s.consolePosition);
  const panelHeight = useExecutionStore((s) => s.panelHeight);
  const panelWidth = useExecutionStore((s) => s.panelWidth);

  // Load the saved layouts once when the picker first appears (Terminal
  // mode entered); failures surface as a toast, the dropdown stays empty.
  useEffect(() => {
    load().catch(() => {
      Message.error(t("outputPanel.terminalLayouts.loadFailed"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backend observations (cwd / ssh connection command) per open session,
  // refreshed whenever the SET of open sessions changes — they feed the
  // dirty marker and the default snapshot of save/update. A save still
  // takes a FRESH measurement at commit time (below), so a stale cache can
  // never be persisted.
  const [descriptions, setDescriptions] = useState<
    Record<string, TerminalSessionDescription>
  >({});
  const sessionKey = useMemo(() => Object.keys(sessions).sort().join(","), [sessions]);
  useEffect(() => {
    let cancelled = false;
    const ids = sessionKey === "" ? [] : sessionKey.split(",");
    void Promise.all(
      ids.map((id) => describeTerminalSession(id).then((d) => [id, d] as const)),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, TerminalSessionDescription> = {};
      for (const [id, description] of pairs) {
        if (description !== null) next[id] = description;
      }
      setDescriptions(next);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  /** Fresh at-commit observation of every open session (never rejects). */
  const describeAllSessions = async (): Promise<
    Record<string, TerminalSessionDescription>
  > => {
    const ids = Object.keys(useTerminalStore.getState().sessions);
    const pairs = await Promise.all(
      ids.map((id) => describeTerminalSession(id).then((d) => [id, d] as const)),
    );
    const next: Record<string, TerminalSessionDescription> = {};
    for (const [id, description] of pairs) {
      if (description !== null) next[id] = description;
    }
    return next;
  };

  const [nameDialog, setNameDialog] = useState<
    { mode: "save" } | { mode: "rename"; layout: TerminalLayoutDto } | null
  >(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState<TerminalLayoutDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TerminalLayoutDto | null>(null);

  const activeLayout = useMemo(
    () => layouts.find((l) => l.id === activeLayoutId) ?? null,
    [layouts, activeLayoutId],
  );

  /**
   * Snapshot of the console's CURRENT display+layout state. Passes the
   * (cached) session observations; save/update call it with a FRESH
   * `describeAllSessions()` result so persisted cwds/ssh commands are
   * measured at commit time, not at last session-set change.
   */
  const buildCurrentState = (
    desc: Record<string, TerminalSessionDescription> = descriptions,
  ): TerminalLayoutState => ({
    position: consolePosition,
    fullscreen: useUIStore.getState().consoleFullscreen,
    size:
      consolePosition === "bottom"
        ? { height: panelHeight }
        : { width: panelWidth },
    layout:
      layoutRoot !== null
        ? snapshotFromState({ layoutRoot, regions, sessions, lastCommands, descriptions: desc })
        : { type: "region", tabs: [{}], activeTabIndex: 0 },
  });

  const isDirty =
    activeLayout !== null && !terminalLayoutStateEquals(buildCurrentState(), activeLayout);
  const hasOpenTerminals = layoutRoot !== null;

  const describeLayout = (layout: TerminalLayoutDto): string => {
    const first = findFirstCommand(layout);
    if (first === null) {
      return t("outputPanel.terminalLayouts.optionDescription", {
        windows: countSpecTabs(layout.layout),
        command: t("outputPanel.terminalLayouts.noCommand"),
      });
    }
    return t(
      first.remote
        ? "outputPanel.terminalLayouts.optionDescriptionRemote"
        : "outputPanel.terminalLayouts.optionDescription",
      { windows: countSpecTabs(layout.layout), command: first.command },
    );
  };

  const options: DropdownOption[] = useMemo(() => {
    const placeholder = {
      value: "",
      label: layouts.length === 0
        ? t("outputPanel.terminalLayouts.none")
        : t("outputPanel.terminalLayouts.label"),
    };
    return [
      placeholder,
      ...layouts.map((layout) => ({
        value: layout.id,
        label:
          layout.id === activeLayoutId && isDirty
            ? `${layout.name} ${t("outputPanel.terminalLayouts.dirtyMarker")}`
            : layout.name,
        description: describeLayout(layout),
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts, activeLayoutId, isDirty, t]);

  const doApply = (layout: TerminalLayoutDto): Promise<void> =>
    applyLayout(layout)
      .then((result) => {
        if (result.droppedTabs > 0) {
          Message.warning(
            t("outputPanel.terminalLayouts.appliedDropped", {
              name: layout.name,
              dropped: result.droppedTabs,
              max: MAX_TERMINAL_SESSIONS,
            }),
          );
        } else {
          Message.success(t("outputPanel.terminalLayouts.applied", { name: layout.name }));
        }
      })
      .catch((err: unknown) => {
        console.error("apply terminal layout failed:", err);
        Message.error(t("outputPanel.terminalLayouts.applyFailed"));
      });

  const handleSelect = (value: string): void => {
    if (value === "" || value === activeLayoutId) return;
    const layout = layouts.find((l) => l.id === value);
    if (!layout) return;
    if (hasOpenTerminals) {
      setConfirmApply(layout);
    } else {
      void doApply(layout);
    }
  };

  const openSaveDialog = (): void => {
    setNameDraft("");
    setNameError(null);
    setNameDialog({ mode: "save" });
  };

  const openRenameDialog = (layout: TerminalLayoutDto): void => {
    setNameDraft(layout.name);
    setNameError(null);
    setNameDialog({ mode: "rename", layout });
  };

  const commitNameDialog = (): void => {
    if (nameDialog === null) return;
    const trimmed = nameDraft.trim();
    if (trimmed === "") {
      setNameError(t("outputPanel.terminalLayouts.nameEmpty"));
      return;
    }
    const duplicate = layouts.some(
      (l) =>
        l.name === trimmed &&
        (nameDialog.mode === "save" || nameDialog.layout.id !== l.id),
    );
    if (duplicate) {
      setNameError(t("outputPanel.terminalLayouts.nameTaken"));
      return;
    }
    // Fresh cwd / ssh-connection measurement at commit time (async), then
    // persist. The backend re-validates the name (UNIQUE) either way.
    const mode = nameDialog;
    void describeAllSessions()
      .then(async (desc) => {
        const current = buildCurrentState(desc);
        const store = useTerminalLayoutsStore.getState();
        if (mode.mode === "save") {
          await store.saveAs(trimmed, current);
        } else {
          await store.rename(mode.layout.id, trimmed);
        }
      })
      .then(() => {
        Message.success(
          t(
            mode.mode === "save"
              ? "outputPanel.terminalLayouts.saved"
              : "outputPanel.terminalLayouts.renamed",
          ),
        );
        setNameDialog(null);
      })
      .catch((err: unknown) => {
        Message.error(err instanceof Error ? err.message : String(err));
      });
  };

  const handleNameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setNameDialog(null);
    }
  };

  const buildManageMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    const items: ContextMenuEntry[] = [
      {
        id: "save-as",
        label: t("outputPanel.terminalLayouts.saveAs"),
        icon: <SaveIcon />,
        disabled: !hasOpenTerminals,
        onSelect: openSaveDialog,
      },
      {
        id: "update",
        label: t("outputPanel.terminalLayouts.update"),
        icon: <SaveIcon />,
        disabled: activeLayout === null || !isDirty,
        onSelect: () => {
          if (activeLayout === null) return;
          // Fresh cwd / ssh measurement at commit time, same as save.
          void describeAllSessions()
            .then((desc) =>
              useTerminalLayoutsStore
                .getState()
                .update(activeLayout.id, buildCurrentState(desc)),
            )
            .then(() => {
              Message.success(t("outputPanel.terminalLayouts.saved"));
            })
            .catch((err: unknown) => {
              console.error("update terminal layout failed:", err);
              Message.error(err instanceof Error ? err.message : String(err));
            });
        },
      },
      {
        id: "rename",
        label: t("outputPanel.terminalLayouts.rename"),
        icon: <EditIcon />,
        disabled: activeLayout === null,
        onSelect: () => {
          if (activeLayout !== null) openRenameDialog(activeLayout);
        },
      },
      { id: "div-delete", divider: true },
      {
        id: "delete",
        label: t("outputPanel.terminalLayouts.delete"),
        icon: <TrashIcon />,
        danger: true,
        disabled: activeLayout === null,
        onSelect: () => {
          if (activeLayout !== null) setConfirmDelete(activeLayout);
        },
      },
    ];
    show({ event, items });
  };

  const dialogTitle =
    nameDialog?.mode === "rename"
      ? t("outputPanel.terminalLayouts.renameTitle")
      : t("outputPanel.terminalLayouts.saveTitle");

  return (
    <div className="output-panel__layout-picker">
      <Dropdown
        value={activeLayoutId ?? ""}
        options={options}
        onChange={handleSelect}
        ariaLabel={t("outputPanel.terminalLayouts.ariaLabel")}
        className="output-panel__layout-select"
        popupClassName="output-panel__layout-popup"
      />
      <button
        type="button"
        className="btn btn--icon output-panel__layout-manage"
        onClick={buildManageMenu}
        title={t("outputPanel.terminalLayouts.manage")}
        aria-label={t("outputPanel.terminalLayouts.manage")}
      >
        <ChevronIcon />
      </button>

      {nameDialog !== null ? (
        <PromptModal
          titleId="terminal-layout-name-title"
          title={dialogTitle}
          dialogClassName="command-form--meta terminal-layout-prompt"
          onBackdropCancel={() => setNameDialog(null)}
        >
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              commitNameDialog();
            }}
          >
            <div className="command-form__body">
              <div className="command-form__field">
                <label className="command-form__label" htmlFor="terminal-layout-name-input">
                  {t("outputPanel.terminalLayouts.nameLabel")}
                </label>
                <span className="command-form__hint" role="note">
                  {t("outputPanel.terminalLayouts.nameHint")}
                </span>
                <input
                  id="terminal-layout-name-input"
                  className={`input${nameError !== null ? " input--error" : ""}`}
                  type="text"
                  value={nameDraft}
                  autoFocus
                  aria-invalid={nameError !== null}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNameDraft(e.target.value);
                    setNameError(null);
                  }}
                  onKeyDown={handleNameKeyDown}
                  placeholder={t("outputPanel.terminalLayouts.namePlaceholder")}
                />
                {nameError !== null ? (
                  <p className="command-form__error" role="alert">
                    {nameError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="command-form__footer">
              <button
                type="button"
                className="btn btn--cancel"
                onClick={() => setNameDialog(null)}
              >
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn btn--primary">
                {t("outputPanel.terminalLayouts.save")}
              </button>
            </div>
          </form>
        </PromptModal>
      ) : null}

      <ConfirmDialog
        open={confirmApply !== null}
        title={t("outputPanel.terminalLayouts.applyTitle")}
        message={
          confirmApply === null
            ? ""
            : t("outputPanel.terminalLayouts.applyMessage", {
                count: Object.keys(sessions).length,
                name: confirmApply.name,
              })
        }
        confirmLabel={t("outputPanel.terminalLayouts.apply")}
        onConfirm={() => {
          const layout = confirmApply;
          setConfirmApply(null);
          if (layout !== null) void doApply(layout);
        }}
        onCancel={() => setConfirmApply(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("outputPanel.terminalLayouts.deleteTitle")}
        message={
          confirmDelete === null
            ? ""
            : t("outputPanel.terminalLayouts.deleteMessage", { name: confirmDelete.name })
        }
        confirmLabel={t("outputPanel.terminalLayouts.delete")}
        danger
        onConfirm={() => {
          const layout = confirmDelete;
          setConfirmDelete(null);
          if (layout === null) return;
          useTerminalLayoutsStore
            .getState()
            .remove(layout.id)
            .then(() => {
              Message.success(t("outputPanel.terminalLayouts.deleted"));
            })
            .catch((err: unknown) => {
              console.error("delete terminal layout failed:", err);
              Message.error(err instanceof Error ? err.message : String(err));
            });
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/**
 * First non-empty saved command in the layout (for the option subtitle),
 * preferring an ssh connection command over a local lastCommand — a remote
 * window replays only the connection, so that is what it "runs".
 */
function findFirstCommand(
  layout: TerminalLayoutDto,
): { command: string; remote: boolean } | null {
  const stack = [layout.layout];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.type === "region") {
      for (const tab of node.tabs) {
        if (tab.remoteCommand && tab.remoteCommand.trim() !== "") {
          return { command: tab.remoteCommand, remote: true };
        }
        if (tab.lastCommand && tab.lastCommand.trim() !== "") {
          return { command: tab.lastCommand, remote: false };
        }
      }
    } else {
      stack.push(...node.children);
    }
  }
  return null;
}
