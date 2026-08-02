import { useEffect, useMemo, useState } from "react";
import type {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Message } from "@arco-design/web-react";
import {
  deleteCommand as deleteCommandWithHistory,
  duplicateCommand,
} from "../../services/commandActions";
import { deleteWorkflow as deleteWorkflowWithHistory } from "../../services/workflowActions";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { buildMiniAppSeedsForPlatform } from "../../stores/miniappSeeds";
import { useScheduleStore } from "../../stores/scheduleStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type {
  Command,
  CommandSortKey,
  LibraryTab,
  MiniApp,
  MiniAppSortKey,
  Workflow,
  WorkflowSortKey,
} from "../../types";
import type { Platform } from "../../types/platform";
import { getPlatform } from "../../utils/platform";
import {
  getCommandDescription,
  getCommandName,
} from "../../utils/commandLabels";
import {
  getMiniAppDescription,
  getMiniAppName,
} from "../../utils/miniappLabels";
import { renderIcon } from "../../utils/iconRenderer";
import {
  collectCategories,
  collectTags,
  filterCommands,
  globalCommands,
} from "../../utils/commandFilters";
import { sortCommands, sortMiniApps, sortWorkflows } from "../../utils/sortLists";
import { paginate } from "../../utils/paginate";
import { triggerCommandRun } from "../../services/commandRunner";
import { triggerWorkflowRun } from "../../services/workflowRunner";
import { BlockedDeleteDialog } from "../BlockedDeleteDialog/BlockedDeleteDialog";
import { CommandView } from "../CommandView";
import { WorkflowView } from "../WorkflowView";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  checkCommandBlockers,
  checkWorkflowBlockers,
} from "../../utils/usageCheck";
import type { DeleteBlocker } from "../../utils/usageCheck";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ListControls } from "../ListControls/ListControls";
import type { SortOption } from "../ListControls/ListControls";
import { Pagination } from "../Pagination/Pagination";
import {
  ChevronIcon,
  CopyIcon,
  EditIcon,
  PlusIcon,
  RunIcon,
  ViewIcon,
} from "../icons";
import { TargetBadge } from "../TargetBadge";
/**
 * Workflows are user-authored, so their `name`/`description` are not run
 * through the seed-localization helper that commands use — they are shown
 * verbatim. Tags are matched case-insensitively, mirroring the command
 * search.
 */
function matchesWorkflowQuery(wf: Workflow, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (wf.name.toLowerCase().includes(q)) return true;
  if (wf.description && wf.description.toLowerCase().includes(q)) return true;
  if (wf.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

/**
 * Case-insensitive name/description/tag match, mirroring
 * `matchesWorkflowQuery`. A seed mini-app's DISPLAYED (translated) labels
 * are matched, so searching for what is on screen works in either
 * language; the literal fields are matched too, because that is what a
 * user-created mini-app carries.
 */
function matchesMiniAppQuery(
  ma: MiniApp,
  query: string,
  t: TFunction,
): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (getMiniAppName(ma, t).toLowerCase().includes(q)) return true;
  const description = getMiniAppDescription(ma, t);
  if (description && description.toLowerCase().includes(q)) return true;
  if (ma.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

interface CommandCardProps {
  cmd: Command;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (cmd: Command) => void;
  /** Double-click opens the read-only view modal (vs. explicit Edit). */
  onView: (cmd: Command) => void;
  /** Create a copy of the command and open its editor. */
  onDuplicate: (cmd: Command) => void;
  /** Render the dense layout: no description, icon-only Run/View buttons. */
  compact?: boolean;
  /**
   * Hide the per-card category chip. Set when the list is grouped BY
   * category — the group header already names the category, so repeating
   * it on every card is redundant.
   */
  hideCategory?: boolean;
}

function buildCommandCardMenuItems(
  cmd: Command,
  isFavorite: boolean,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: (id: string) => void;
    onEdit: (cmd: Command) => void;
    onView: (cmd: Command) => void;
    onDuplicate: (cmd: Command) => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => {
        void triggerCommandRun(cmd);
      },
    },
    {
      id: "view",
      label: t("contextMenu.view"),
      onSelect: () => actions.onView(cmd),
    },
    {
      id: "duplicate",
      label: t("contextMenu.duplicate"),
      onSelect: () => actions.onDuplicate(cmd),
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
      onSelect: () => actions.onEdit(cmd),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(cmd.id),
    },
  ];
}

function CommandCard({
  cmd,
  isFavorite,
  onToggleFavorite,
  onDelete,
  onEdit,
  onView,
  onDuplicate,
  compact = false,
  hideCategory = false,
}: CommandCardProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const favoriteLabel = isFavorite
    ? t("library.unfavorite")
    : t("library.favorite");
  const displayName = getCommandName(cmd, t);
  const displayDesc = getCommandDescription(cmd, t);

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildCommandCardMenuItems(cmd, isFavorite, t, {
        onToggleFavorite,
        onDelete,
        onEdit,
        onView,
        onDuplicate,
      }),
    });
  };

  // Double-click anywhere on the card opens the read-only view modal. Inner
  // controls (the favorite-toggle and the Run button) stopPropagation on
  // their own click handlers so a quick double-click on those does NOT also
  // open the view. We only need to handle the card-level double-click here.
  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    onView(cmd);
  };

  const handleFavoriteClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onToggleFavorite(cmd.id);
  };

  const handleRunClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    void triggerCommandRun(cmd);
  };

  const handleViewClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onView(cmd);
  };

  return (
    <div
      className={`list-tile list-tile--command${compact ? " list-tile--compact" : ""}`}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <div className="list-tile__head">
        <div className="list-tile__heading">
          <h3 className="list-tile__title" title={displayName}>
            {displayName}
          </h3>
          {!compact && displayDesc ? (
            <p className="list-tile__desc">{displayDesc}</p>
          ) : null}
        </div>
        {compact ? (
          <div className="list-tile__head-actions">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={handleRunClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("common.run")}
              title={t("common.run")}
            >
              <RunIcon />
            </button>
            <button
              type="button"
              className="btn btn--view btn--icon"
              onClick={handleViewClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("library.view")}
              title={t("library.view")}
            >
              <ViewIcon />
            </button>
            <button
              type="button"
              className={`favorite-toggle${isFavorite ? " is-on" : ""}`}
              onClick={handleFavoriteClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={favoriteLabel}
              title={favoriteLabel}
            >
              {isFavorite ? "♥" : "♡"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`favorite-toggle${isFavorite ? " is-on" : ""}`}
            onClick={handleFavoriteClick}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label={favoriteLabel}
            title={favoriteLabel}
          >
            {isFavorite ? "♥" : "♡"}
          </button>
        )}
      </div>
      <div className="list-tile__meta">
        <TargetBadge target={cmd.target} />
        {cmd.shell ? <span className="shell-badge">{cmd.shell}</span> : null}
        {!hideCategory &&
        cmd.categoryId !== undefined &&
        cmd.categoryId.trim() !== "" ? (
          <span className="category-chip">{cmd.categoryId}</span>
        ) : null}
        {cmd.tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
          </span>
        ))}
      </div>
      {!compact ? (
        <div className="list-tile__actions">
          <button
            type="button"
            className="btn btn--run"
            onClick={handleRunClick}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <RunIcon />
            {t("common.run")}
          </button>
          <button
            type="button"
            className="btn btn--view"
            onClick={handleViewClick}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="btn--view-icon">
              <ViewIcon />
            </span>
            {t("library.view")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface WorkflowCardProps {
  workflow: Workflow;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (workflow: Workflow) => void;
  /** Double-click opens the read-only view modal (vs. explicit Edit). */
  onView: (workflow: Workflow) => void;
  /** Render the dense layout: no description, icon-only Run/View buttons. */
  compact?: boolean;
}

function buildWorkflowCardMenuItems(
  workflow: Workflow,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: (id: string) => void;
    onEdit: (workflow: Workflow) => void;
    onView: (workflow: Workflow) => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => {
        void triggerWorkflowRun(workflow);
      },
    },
    {
      id: "view",
      label: t("contextMenu.view"),
      onSelect: () => actions.onView(workflow),
    },
    {
      id: "favorite",
      label: workflow.favorite
        ? t("contextMenu.favoriteRemove")
        : t("contextMenu.favoriteAdd"),
      onSelect: () => actions.onToggleFavorite(workflow.id),
    },
    { id: "div1", divider: true },
    {
      id: "edit",
      label: t("contextMenu.edit"),
      onSelect: () => actions.onEdit(workflow),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(workflow.id),
    },
  ];
}

function WorkflowCard({
  workflow,
  onToggleFavorite,
  onDelete,
  onEdit,
  onView,
  compact = false,
}: WorkflowCardProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const favoriteLabel = workflow.favorite
    ? t("workflow.unfavorite")
    : t("workflow.favorite");

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildWorkflowCardMenuItems(workflow, t, {
        onToggleFavorite,
        onDelete,
        onEdit,
        onView,
      }),
    });
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    onView(workflow);
  };

  const handleFavoriteClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onToggleFavorite(workflow.id);
  };

  const handleRunClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    void triggerWorkflowRun(workflow);
  };

  const handleViewClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onView(workflow);
  };

  return (
    <div
      className={`list-tile list-tile--workflow${compact ? " list-tile--compact" : ""}`}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <div className="list-tile__head">
        <div className="list-tile__heading">
          <h3 className="list-tile__title" title={workflow.name}>
            {workflow.name}
          </h3>
          {!compact && workflow.description ? (
            <p className="list-tile__desc">{workflow.description}</p>
          ) : null}
        </div>
        {compact ? (
          <div className="list-tile__head-actions">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={handleRunClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("workflow.run")}
              title={t("workflow.run")}
            >
              <RunIcon />
            </button>
            <button
              type="button"
              className="btn btn--view btn--icon"
              onClick={handleViewClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("workflow.view")}
              title={t("workflow.view")}
            >
              <ViewIcon />
            </button>
            <button
              type="button"
              className={`favorite-toggle${workflow.favorite ? " is-on" : ""}`}
              onClick={handleFavoriteClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={favoriteLabel}
              title={favoriteLabel}
            >
              {workflow.favorite ? "♥" : "♡"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`favorite-toggle${workflow.favorite ? " is-on" : ""}`}
            onClick={handleFavoriteClick}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label={favoriteLabel}
            title={favoriteLabel}
          >
            {workflow.favorite ? "♥" : "♡"}
          </button>
        )}
      </div>
      <div className="list-tile__meta">
        {workflow.tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
          </span>
        ))}
      </div>
      {!compact ? (
        <div className="list-tile__actions">
          <button
            type="button"
            className="btn btn--run"
            onClick={handleRunClick}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <RunIcon />
            {t("workflow.run")}
          </button>
          <button
            type="button"
            className="btn btn--view"
            onClick={handleViewClick}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="btn--view-icon">
              <ViewIcon />
            </span>
            {t("workflow.view")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Sentinel value for the "all categories" option in the category filter. */
const ALL_CATEGORIES = "";

/** Grid template (column widths) for the command table rows. */
const COMMAND_TABLE_COLUMNS = "auto minmax(0, 2fr) 1fr 1fr";

/** Format an ISO date for table display, locale-aware. Empty on bad input. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

interface CommandTableProps {
  commands: ReadonlyArray<Command>;
  favorites: ReadonlyArray<string>;
  onRun: (cmd: Command) => void;
  onView: (cmd: Command) => void;
}

/** Tabular layout for commands (table view mode). */
function CommandTable({
  commands,
  favorites,
  onRun,
  onView,
}: CommandTableProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="table" role="table" aria-label={t("library.title")}>
      <div
        className="table__row table__head"
        role="row"
        style={{ gridTemplateColumns: COMMAND_TABLE_COLUMNS }}
      >
        <span className="table__cell" role="columnheader" aria-hidden="true" />
        <span className="table__cell" role="columnheader">
          {t("listView.sortByName")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("listView.columnCategory")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("listView.sortByCreatedAt")}
        </span>
      </div>
      {commands.map((cmd) => {
        const isFavorite = favorites.includes(cmd.id);
        return (
          <div
            key={cmd.id}
            className="table__row table__row--body table__row--clickable"
            role="row"
            onClick={() => onView(cmd)}
            style={{ gridTemplateColumns: COMMAND_TABLE_COLUMNS }}
          >
            <span className="table__cell table__cell--actions" role="cell">
              <button
                type="button"
                className="btn btn--run btn--icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onRun(cmd);
                }}
                aria-label={t("common.run")}
                title={t("common.run")}
              >
                <RunIcon />
              </button>
            </span>
            <span className="table__cell" role="cell">
              {isFavorite ? "♥ " : ""}
              {getCommandName(cmd, t)}
            </span>
            <span className="table__cell table__cell--muted" role="cell">
              {cmd.categoryId !== undefined && cmd.categoryId.trim() !== ""
                ? cmd.categoryId
                : t("listView.uncategorized")}
            </span>
            <span className="table__cell table__cell--muted" role="cell">
              {formatDate(cmd.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface CommandGroup {
  /** Category id, or the empty string for the synthetic "uncategorized" group. */
  key: string;
  label: string;
  commands: Command[];
}

/**
 * Partition commands into category groups, each internally sorted by the
 * active sort. Real categories come first (sorted by name); the synthetic
 * "uncategorized" bucket is always last. Commands with a blank `categoryId`
 * fall into the uncategorized bucket.
 */
function groupCommandsByCategory(
  commands: ReadonlyArray<Command>,
  sortKey: CommandSortKey,
  sortDir: "asc" | "desc",
  nameOf: (cmd: Command) => string,
  uncategorizedLabel: string,
): CommandGroup[] {
  const byCategory = new Map<string, Command[]>();
  for (const cmd of commands) {
    const cat =
      cmd.categoryId !== undefined && cmd.categoryId.trim() !== ""
        ? cmd.categoryId
        : "";
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(cmd);
    else byCategory.set(cat, [cmd]);
  }

  const namedKeys = [...byCategory.keys()]
    .filter((key) => key !== "")
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const orderedKeys = byCategory.has("") ? [...namedKeys, ""] : namedKeys;

  return orderedKeys.map((key) => ({
    key,
    label: key === "" ? uncategorizedLabel : key,
    commands: sortCommands(
      byCategory.get(key) ?? [],
      { key: sortKey, dir: sortDir },
      nameOf,
    ),
  }));
}

interface CommandGroupSectionProps {
  group: CommandGroup;
  favorites: ReadonlyArray<string>;
  isOpen: boolean;
  onToggleOpen: (key: string) => void;
  onToggleFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (cmd: Command) => void;
  onView: (cmd: Command) => void;
  onDuplicate: (cmd: Command) => void;
  /** Render member cards in the dense compact layout. */
  compact: boolean;
}

/** A collapsible category section in the grouped Commands view. */
function CommandGroupSection({
  group,
  favorites,
  isOpen,
  onToggleOpen,
  onToggleFavorite,
  onDelete,
  onEdit,
  onView,
  onDuplicate,
  compact,
}: CommandGroupSectionProps): ReactElement {
  return (
    <section className="list-group">
      <button
        type="button"
        className={"list-group__header" + (isOpen ? " is-open" : "")}
        aria-expanded={isOpen}
        onClick={() => onToggleOpen(group.key)}
      >
        <span className="list-group__chevron">
          <ChevronIcon />
        </span>
        {group.label}
        <span className="list-group__count">{group.commands.length}</span>
      </button>
      {isOpen ? (
        <div className="list-group__body">
          <div className={`command-list${compact ? " command-list--compact" : ""}`}>
            {group.commands.map((cmd) => (
              <CommandCard
                key={cmd.id}
                cmd={cmd}
                isFavorite={favorites.includes(cmd.id)}
                onToggleFavorite={onToggleFavorite}
                onDelete={onDelete}
                onEdit={onEdit}
                onView={onView}
                onDuplicate={onDuplicate}
                compact={compact}
                hideCategory
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CommandsTab(): ReactElement {
  const { t } = useTranslation();
  const allCommands = useCommandStore((s) => s.commands);
  // The global Library never shows workflow-private `local` commands — they
  // are visible only inside their owning workflow's editor. Filter them out
  // once at the top so the list, search, tag/category options, and delete
  // blocker checks all operate on the global subset.
  const commands = useMemo(() => globalCommands(allCommands), [allCommands]);
  const favorites = useCommandStore((s) => s.favorites);
  const toggleFavorite = useCommandStore((s) => s.toggleFavorite);
  // History-aware delete: routes through the `commandActions` wrapper
  // so a `commandDeleted` event is logged for the History view's
  // restore flow. Never call `useCommandStore.getState().deleteCommand`
  // directly from UI code — see services/commandActions.ts.
  const deleteCommand = deleteCommandWithHistory;
  const setView = useUIStore((s) => s.setView);
  const setCommandEditorTarget = useUIStore((s) => s.setCommandEditorTarget);
  const setCommandEditorDirty = useUIStore((s) => s.setCommandEditorDirty);
  const view = useUIStore((s) => s.commandsView);
  const updateView = useUIStore((s) => s.updateCommandsView);
  const workflows = useWorkflowStore((s) => s.workflows);
  const schedules = useScheduleStore((s) => s.schedules);
  const [query, setQuery] = useState<string>("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  // Transient table page (1-based); reset to 1 whenever the result set or
  // ordering changes. Not persisted — only the view preference is.
  const [page, setPage] = useState<number>(1);
  // Which category sections are collapsed in grouped mode (by category key,
  // "" = uncategorized). Default-open: a key is collapsed only when present.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  // The command staged for deletion (awaiting confirmation), or null.
  const [pendingDelete, setPendingDelete] = useState<Command | null>(null);
  // Blockers preventing the staged delete (non-empty = show blocked dialog).
  const [deleteBlockers, setDeleteBlockers] = useState<DeleteBlocker[]>([]);
  // The command shown in the read-only view modal (double-click), or null.
  const [viewCommand, setViewCommand] = useState<Command | null>(null);

  // Option sets derived from the current commands — categories are modeled
  // inline (no separate entity), so the universe of tags/categories is
  // simply what the commands already use.
  const allTags = useMemo(() => collectTags(commands), [commands]);
  const allCategories = useMemo(() => collectCategories(commands), [commands]);

  // Drop any selected tag/category that no longer exists (e.g. after an
  // edit removed the last command using it) so a stale filter can't hide
  // everything with no way to clear it from the visible chips.
  const effectiveTags = useMemo(
    () => activeTags.filter((tag) => allTags.includes(tag)),
    [activeTags, allTags],
  );
  const effectiveCategory =
    category !== ALL_CATEGORIES && allCategories.includes(category)
      ? category
      : ALL_CATEGORIES;

  const filtered = useMemo(
    () =>
      filterCommands(
        commands,
        {
          query,
          tags: effectiveTags,
          category:
            effectiveCategory === ALL_CATEGORIES
              ? undefined
              : effectiveCategory,
        },
        t,
      ),
    [commands, query, effectiveTags, effectiveCategory, t],
  );

  const categoryOptions: ReadonlyArray<DropdownOption> = useMemo(
    () => [
      { value: ALL_CATEGORIES, label: t("library.allCategories") },
      ...allCategories.map((cat) => ({ value: cat, label: cat })),
    ],
    [allCategories, t],
  );

  const sortOptions: ReadonlyArray<SortOption<CommandSortKey>> = useMemo(
    () => [
      { key: "createdAt", dir: "desc", label: t("listView.sortNewestFirst") },
      { key: "createdAt", dir: "asc", label: t("listView.sortOldestFirst") },
      { key: "name", dir: "asc", label: t("listView.sortNameAsc") },
      { key: "name", dir: "desc", label: t("listView.sortNameDesc") },
    ],
    [t],
  );

  // Filtered + sorted list (flat). Name sort uses the localized label so the
  // order matches what the card/table shows.
  const sorted = useMemo(
    () =>
      sortCommands(filtered, { key: view.sortKey, dir: view.sortDir }, (cmd) =>
        getCommandName(cmd, t),
      ),
    [filtered, view.sortKey, view.sortDir, t],
  );

  // Category groups (grouped mode only). Each group is internally sorted.
  const groups = useMemo(
    () =>
      view.grouped
        ? groupCommandsByCategory(
            filtered,
            view.sortKey,
            view.sortDir,
            (cmd) => getCommandName(cmd, t),
            t("listView.uncategorized"),
          )
        : [],
    [filtered, view.grouped, view.sortKey, view.sortDir, t],
  );

  // Table page slice (table mode, ungrouped only). `paginate` clamps the page
  // so a stale page self-corrects after filtering shrinks the list.
  const pageResult = useMemo(
    () => paginate(sorted, page, view.pageSize),
    [sorted, page, view.pageSize],
  );

  const toggleGroupOpen = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filtersActive =
    query.trim() !== "" ||
    effectiveTags.length > 0 ||
    effectiveCategory !== ALL_CATEGORIES;

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
  };

  const toggleTag = (tag: string): void => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t2) => t2 !== tag) : [...prev, tag],
    );
  };

  const clearFilters = (): void => {
    setQuery("");
    setActiveTags([]);
    setCategory(ALL_CATEGORIES);
  };

  // Open the full-screen command editor view. We reset the editor's dirty
  // flag up front so a stale "dirty" from a previous session can't block
  // the very first navigation, then set the target and switch views.
  const handleEdit = (cmd: Command): void => {
    setCommandEditorDirty(false);
    setCommandEditorTarget({ mode: "edit", commandId: cmd.id });
    setView("command-editor");
  };

  const handleView = (cmd: Command): void => {
    setViewCommand(cmd);
  };

  // Duplicate a command (context-menu "Create copy"): persist a copy with a
  // localized name prefix, then open the new copy's editor so the user lands
  // straight in it — mirrors `handleEdit`'s navigation.
  const handleDuplicate = (cmd: Command): void => {
    const copy = duplicateCommand(cmd, t("contextMenu.duplicatePrefix"));
    setCommandEditorDirty(false);
    setCommandEditorTarget({ mode: "edit", commandId: copy.id });
    setView("command-editor");
  };

  // Stage a delete: check for dependent workflows/schedules first. If any
  // exist, show the BlockedDeleteDialog instead of the confirm dialog.
  const requestDelete = (id: string): void => {
    const target = commands.find((c) => c.id === id);
    if (target === undefined) return;
    const blockers = checkCommandBlockers(id, workflows, schedules);
    if (blockers.length > 0) {
      setDeleteBlockers(blockers);
      setPendingDelete(target);
    } else {
      setDeleteBlockers([]);
      setPendingDelete(target);
    }
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    deleteCommand(pendingDelete.id);
    setPendingDelete(null);
    setDeleteBlockers([]);
  };

  // Any change that reorders or reshapes the result set returns to page 1 so
  // the user is never stranded on a now-empty page.
  const handleSearchReset = (e: ChangeEvent<HTMLInputElement>): void => {
    handleSearch(e);
    setPage(1);
  };

  const showTable = view.mode === "table" && !view.grouped;
  const compact = view.mode === "compact";

  return (
    <>
      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={t("library.searchPlaceholder")}
          value={query}
          onChange={handleSearchReset}
        />
        {allCategories.length > 0 ? (
          <Dropdown
            value={effectiveCategory}
            options={categoryOptions}
            onChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
            ariaLabel={t("library.filterByCategory")}
          />
        ) : null}
        <ListControls
          sortOptions={sortOptions}
          sortKey={view.sortKey}
          sortDir={view.sortDir}
          onSortChange={(key, dir) => {
            updateView({ sortKey: key, sortDir: dir });
            setPage(1);
          }}
          mode={view.mode}
          onModeChange={(mode) => {
            // Grouping is supported in both tile layouts (tiles / compact) but
            // not in the table view. Switching to table therefore turns
            // grouping off; switching between tile layouts keeps it.
            updateView(mode === "table" ? { mode, grouped: false } : { mode });
          }}
          grouped={view.grouped}
          onGroupedChange={(grouped) => {
            // Grouping renders as tiles; if the user enables it while in table
            // mode, fall back to the expanded tile layout. A compact tile mode
            // is preserved (grouped compact tiles are valid).
            const nextMode =
              grouped && view.mode === "table" ? "tiles" : view.mode;
            updateView({ grouped, mode: nextMode });
            setPage(1);
          }}
        />
      </div>

      {allTags.length > 0 ? (
        <div
          className="library-filter-tags"
          role="group"
          aria-label={t("library.filterByTag")}
        >
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`tag-chip tag-chip--filter${
                effectiveTags.includes(tag) ? " is-active" : ""
              }`}
              aria-pressed={effectiveTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
          {filtersActive ? (
            <button
              type="button"
              className="btn btn--ghost library-filter-clear"
              onClick={clearFilters}
            >
              {t("library.clearFilters")}
            </button>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="empty-state">
          {commands.length === 0
            ? t("library.noCommands")
            : t("library.noResults")}
        </div>
      ) : view.grouped ? (
        groups.map((group) => (
          <CommandGroupSection
            key={group.key}
            group={group}
            favorites={favorites}
            isOpen={!collapsedGroups.has(group.key)}
            onToggleOpen={toggleGroupOpen}
            onToggleFavorite={toggleFavorite}
            onDelete={requestDelete}
            onEdit={handleEdit}
            onView={handleView}
            onDuplicate={handleDuplicate}
            compact={compact}
          />
        ))
      ) : showTable ? (
        <>
          <CommandTable
            commands={pageResult.pageItems}
            favorites={favorites}
            onRun={(cmd) => void triggerCommandRun(cmd)}
            onView={handleView}
          />
          <Pagination
            page={pageResult.page}
            totalPages={pageResult.totalPages}
            pageSize={view.pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              updateView({ pageSize: size });
              setPage(1);
            }}
          />
        </>
      ) : (
        <div className={`command-list${compact ? " command-list--compact" : ""}`}>
          {sorted.map((cmd) => (
            <CommandCard
              key={cmd.id}
              cmd={cmd}
              isFavorite={favorites.includes(cmd.id)}
              onToggleFavorite={toggleFavorite}
              onDelete={requestDelete}
              onEdit={handleEdit}
              onView={handleView}
              onDuplicate={handleDuplicate}
              compact={compact}
            />
          ))}
        </div>
      )}

      {pendingDelete !== null && deleteBlockers.length > 0 ? (
        <BlockedDeleteDialog
          objectName={getCommandName(pendingDelete, t)}
          blockers={deleteBlockers}
          onClose={() => {
            setPendingDelete(null);
            setDeleteBlockers([]);
          }}
        />
      ) : (
        <ConfirmDialog
          open={pendingDelete !== null}
          title={t("library.deleteConfirmTitle")}
          message={t("library.deleteConfirm", {
            name: pendingDelete !== null ? getCommandName(pendingDelete, t) : "",
          })}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <CommandView
        command={viewCommand}
        onClose={() => setViewCommand(null)}
        onEdit={(cmd) => {
          setViewCommand(null);
          handleEdit(cmd);
        }}
        onRun={(cmd) => {
          setViewCommand(null);
          void triggerCommandRun(cmd);
        }}
        onDelete={(cmd) => {
          setViewCommand(null);
          requestDelete(cmd.id);
        }}
      />
    </>
  );
}

/** Grid template (column widths) for the workflow table rows. */
const WORKFLOW_TABLE_COLUMNS = "auto minmax(0, 2fr) 1fr";

interface WorkflowTableProps {
  workflows: ReadonlyArray<Workflow>;
  onRun: (workflow: Workflow) => void;
  onView: (workflow: Workflow) => void;
}

/** Tabular layout for workflows (table view mode). */
function WorkflowTable({
  workflows,
  onRun,
  onView,
}: WorkflowTableProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className="table"
      role="table"
      aria-label={t("workflow.tabs.workflows")}
    >
      <div
        className="table__row table__head"
        role="row"
        style={{ gridTemplateColumns: WORKFLOW_TABLE_COLUMNS }}
      >
        <span className="table__cell" role="columnheader" aria-hidden="true" />
        <span className="table__cell" role="columnheader">
          {t("listView.sortByName")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("listView.sortByCreatedAt")}
        </span>
      </div>
      {workflows.map((workflow) => (
        <div
          key={workflow.id}
          className="table__row table__row--body table__row--clickable"
          role="row"
          onClick={() => onView(workflow)}
          style={{ gridTemplateColumns: WORKFLOW_TABLE_COLUMNS }}
        >
          <span className="table__cell table__cell--actions" role="cell">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={(e) => {
                e.stopPropagation();
                onRun(workflow);
              }}
              aria-label={t("workflow.run")}
              title={t("workflow.run")}
            >
              <RunIcon />
            </button>
          </span>
          <span className="table__cell" role="cell">
            {workflow.favorite ? "♥ " : ""}
            {workflow.name}
          </span>
          <span className="table__cell table__cell--muted" role="cell">
            {formatDate(workflow.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkflowsTab(): ReactElement {
  const { t } = useTranslation();
  const workflows = useWorkflowStore((s) => s.workflows);
  const toggleFavorite = useWorkflowStore((s) => s.toggleFavorite);
  const setView = useUIStore((s) => s.setView);
  const workflowView = useUIStore((s) => s.workflowsView);
  const updateWorkflowView = useUIStore((s) => s.updateWorkflowsView);
  const setEditorWorkflowId = useUIStore((s) => s.setEditorWorkflowId);
  // History-aware delete: routes through `workflowActions` so a
  // `workflowDeleted` event is logged for the History view's restore
  // flow — same contract as commands.
  const deleteWorkflow = deleteWorkflowWithHistory;
  const schedules = useScheduleStore((s) => s.schedules);
  const [query, setQuery] = useState<string>("");
  // Transient table page (1-based); reset on filter/sort/page-size changes.
  const [page, setPage] = useState<number>(1);
  // The workflow currently shown in the read-only view modal (double-click),
  // or null when closed. Editing starts from that modal's Edit button.
  const [viewWorkflow, setViewWorkflow] = useState<Workflow | null>(null);
  // The workflow staged for deletion (awaiting confirmation), or null.
  const [pendingDelete, setPendingDelete] = useState<Workflow | null>(null);
  // Blockers preventing the staged delete (non-empty = show blocked dialog).
  const [deleteBlockers, setDeleteBlockers] = useState<DeleteBlocker[]>([]);

  const filtered = useMemo(
    () => workflows.filter((w) => matchesWorkflowQuery(w, query)),
    [workflows, query],
  );

  const sortOptions: ReadonlyArray<SortOption<WorkflowSortKey>> = useMemo(
    () => [
      { key: "createdAt", dir: "desc", label: t("listView.sortNewestFirst") },
      { key: "createdAt", dir: "asc", label: t("listView.sortOldestFirst") },
      { key: "name", dir: "asc", label: t("listView.sortNameAsc") },
      { key: "name", dir: "desc", label: t("listView.sortNameDesc") },
    ],
    [t],
  );

  const sorted = useMemo(
    () =>
      sortWorkflows(filtered, {
        key: workflowView.sortKey,
        dir: workflowView.sortDir,
      }),
    [filtered, workflowView.sortKey, workflowView.sortDir],
  );

  const pageResult = useMemo(
    () => paginate(sorted, page, workflowView.pageSize),
    [sorted, page, workflowView.pageSize],
  );

  const showTable = workflowView.mode === "table";
  const compact = workflowView.mode === "compact";

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
    setPage(1);
  };

  const openEditor = (workflowId: string | null): void => {
    setEditorWorkflowId(workflowId);
    setView("editor");
  };

  const handleEdit = (workflow: Workflow): void => {
    openEditor(workflow.id);
  };

  const handleView = (workflow: Workflow): void => {
    setViewWorkflow(workflow);
  };

  // Stage a delete: check for dependent schedules first. If any exist, show
  // the BlockedDeleteDialog instead of the confirm dialog.
  const requestDelete = (id: string): void => {
    const target = workflows.find((w) => w.id === id);
    if (target === undefined) return;
    const blockers = checkWorkflowBlockers(id, schedules);
    setDeleteBlockers(blockers);
    setPendingDelete(target);
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    deleteWorkflow(pendingDelete.id);
    setPendingDelete(null);
    setDeleteBlockers([]);
  };

  return (
    <>
      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={t("workflow.searchPlaceholder")}
          value={query}
          onChange={handleSearch}
        />
        <ListControls
          sortOptions={sortOptions}
          sortKey={workflowView.sortKey}
          sortDir={workflowView.sortDir}
          onSortChange={(key, dir) => {
            updateWorkflowView({ sortKey: key, sortDir: dir });
            setPage(1);
          }}
          mode={workflowView.mode}
          onModeChange={(mode) => updateWorkflowView({ mode })}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          {workflows.length === 0
            ? t("workflow.noWorkflows")
            : t("workflow.noResults")}
        </div>
      ) : showTable ? (
        <>
          <WorkflowTable
            workflows={pageResult.pageItems}
            onRun={(wf) => void triggerWorkflowRun(wf)}
            onView={handleView}
          />
          <Pagination
            page={pageResult.page}
            totalPages={pageResult.totalPages}
            pageSize={workflowView.pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              updateWorkflowView({ pageSize: size });
              setPage(1);
            }}
          />
        </>
      ) : (
        <div className={`command-list${compact ? " command-list--compact" : ""}`}>
          {sorted.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              onToggleFavorite={toggleFavorite}
              onDelete={requestDelete}
              onEdit={handleEdit}
              onView={handleView}
              compact={compact}
            />
          ))}
        </div>
      )}

      {pendingDelete !== null && deleteBlockers.length > 0 ? (
        <BlockedDeleteDialog
          objectName={pendingDelete.name}
          blockers={deleteBlockers}
          onClose={() => {
            setPendingDelete(null);
            setDeleteBlockers([]);
          }}
        />
      ) : (
        <ConfirmDialog
          open={pendingDelete !== null}
          title={t("workflow.deleteConfirmTitle")}
          message={t("workflow.deleteConfirm", {
            name: pendingDelete?.name ?? "",
          })}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <WorkflowView
        workflow={viewWorkflow}
        onClose={() => setViewWorkflow(null)}
        onEdit={(wf) => {
          setViewWorkflow(null);
          handleEdit(wf);
        }}
        onRun={(wf) => {
          setViewWorkflow(null);
          void triggerWorkflowRun(wf);
        }}
        onDelete={(wf) => {
          setViewWorkflow(null);
          requestDelete(wf.id);
        }}
      />
    </>
  );
}

interface MiniAppCardProps {
  miniapp: MiniApp;
  onToggleFavorite: (id: string) => void;
  onDelete: (miniapp: MiniApp) => void;
  onEdit: (miniapp: MiniApp) => void;
  onRun: (miniapp: MiniApp) => void;
  /** Render the dense layout: no description, icon-only Run/Edit buttons. */
  compact?: boolean;
}

function buildMiniAppCardMenuItems(
  miniapp: MiniApp,
  t: TFunction,
  actions: {
    onToggleFavorite: (id: string) => void;
    onDelete: (miniapp: MiniApp) => void;
    onEdit: (miniapp: MiniApp) => void;
    onRun: (miniapp: MiniApp) => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => actions.onRun(miniapp),
    },
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
      onSelect: () => actions.onEdit(miniapp),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(miniapp),
    },
  ];
}

function MiniAppCard({
  miniapp,
  onToggleFavorite,
  onDelete,
  onEdit,
  onRun,
  compact = false,
}: MiniAppCardProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const favoriteLabel = miniapp.favorite
    ? t("miniapps.unfavorite")
    : t("miniapps.favorite");

  // Seed mini-apps render their translated labels; user-created ones their
  // literal `name` / `description`.
  const displayName = getMiniAppName(miniapp, t);
  const displayDescription = getMiniAppDescription(miniapp, t);

  const widgetCount = miniapp.widgets.length;
  const widgetLabel = t("miniapps.widgetsCount", { count: widgetCount });

  const handleFavoriteClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onToggleFavorite(miniapp.id);
  };

  const handleRunClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onRun(miniapp);
  };

  const handleEditClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onEdit(miniapp);
  };

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildMiniAppCardMenuItems(miniapp, t, {
        onToggleFavorite,
        onDelete,
        onEdit,
        onRun,
      }),
    });
  };

  return (
    <div
      className={`list-tile list-tile--miniapp${compact ? " list-tile--compact" : ""}`}
      onContextMenu={handleContextMenu}
    >
      <div className="list-tile__head">
        <div className="list-tile__heading">
          <h3 className="list-tile__title" title={displayName}>
            {renderIcon(miniapp.icon, 20, "list-tile__icon")}
            {displayName}
          </h3>
          {!compact && displayDescription ? (
            <p className="list-tile__desc">{displayDescription}</p>
          ) : null}
        </div>
        {compact ? (
          <div className="list-tile__head-actions">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={handleRunClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("miniapps.run")}
              title={t("miniapps.run")}
            >
              <RunIcon />
            </button>
            <button
              type="button"
              className="btn btn--edit btn--icon"
              onClick={handleEditClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("miniapps.edit")}
              title={t("miniapps.edit")}
            >
              <EditIcon />
            </button>
            <button
              type="button"
              className={`favorite-toggle${miniapp.favorite ? " is-on" : ""}`}
              onClick={handleFavoriteClick}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={favoriteLabel}
              title={favoriteLabel}
            >
              {miniapp.favorite ? "♥" : "♡"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`favorite-toggle${miniapp.favorite ? " is-on" : ""}`}
            onClick={handleFavoriteClick}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label={favoriteLabel}
            title={favoriteLabel}
          >
            {miniapp.favorite ? "♥" : "♡"}
          </button>
        )}
      </div>
      <div className="list-tile__meta">
        <span className="shell-badge">{widgetLabel}</span>
        {miniapp.categoryId !== undefined &&
        miniapp.categoryId.trim() !== "" ? (
          <span className="category-chip">{miniapp.categoryId}</span>
        ) : null}
        {miniapp.tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
          </span>
        ))}
      </div>
      {!compact ? (
        <div className="list-tile__actions">
          <button type="button" className="btn btn--run" onClick={handleRunClick}>
            <RunIcon />
            {t("miniapps.run")}
          </button>
          {/* The outlined variant tints its glyph via the `btn--edit-icon`
              wrapper — a bare glyph renders in the neutral label colour, which
              defeats the point of the variant. */}
          <button type="button" className="btn btn--edit" onClick={handleEditClick}>
            <span className="btn--edit-icon">
              <EditIcon />
            </span>
            {t("miniapps.edit")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Grid template (column widths) for the mini-app table rows. */
const MINIAPP_TABLE_COLUMNS = "auto minmax(0, 2fr) 1fr 1fr";

interface MiniAppTableProps {
  miniapps: ReadonlyArray<MiniApp>;
  onRun: (miniapp: MiniApp) => void;
  onEdit: (miniapp: MiniApp) => void;
}

/** Tabular layout for mini-apps (table view mode). */
function MiniAppTable({
  miniapps,
  onRun,
  onEdit,
}: MiniAppTableProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className="table"
      role="table"
      aria-label={t("workflow.tabs.miniapps")}
    >
      <div
        className="table__row table__head"
        role="row"
        style={{ gridTemplateColumns: MINIAPP_TABLE_COLUMNS }}
      >
        <span className="table__cell" role="columnheader" aria-hidden="true" />
        <span className="table__cell" role="columnheader">
          {t("listView.sortByName")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("listView.columnCategory")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("listView.sortByCreatedAt")}
        </span>
      </div>
      {miniapps.map((miniapp) => (
        <div
          key={miniapp.id}
          className="table__row table__row--body table__row--clickable"
          role="row"
          onClick={() => onEdit(miniapp)}
          style={{ gridTemplateColumns: MINIAPP_TABLE_COLUMNS }}
        >
          <span className="table__cell table__cell--actions" role="cell">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={(e) => {
                e.stopPropagation();
                onRun(miniapp);
              }}
              aria-label={t("miniapps.run")}
              title={t("miniapps.run")}
            >
              <RunIcon />
            </button>
          </span>
          <span className="table__cell" role="cell">
            {miniapp.favorite ? "♥ " : ""}
            {getMiniAppName(miniapp, t)}
          </span>
          <span className="table__cell table__cell--muted" role="cell">
            {miniapp.categoryId !== undefined && miniapp.categoryId.trim() !== ""
              ? miniapp.categoryId
              : t("listView.uncategorized")}
          </span>
          <span className="table__cell table__cell--muted" role="cell">
            {formatDate(miniapp.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function MiniAppsTab(): ReactElement {
  const { t } = useTranslation();
  const miniapps = useMiniAppStore((s) => s.miniapps);
  const hydrated = useMiniAppStore((s) => s.hydrated);
  const toggleFavorite = useMiniAppStore((s) => s.toggleFavorite);
  const deleteMiniApp = useMiniAppStore((s) => s.deleteMiniApp);
  const addMiniApp = useMiniAppStore((s) => s.addMiniApp);
  const setView = useUIStore((s) => s.setView);
  const setMiniappEditorId = useUIStore((s) => s.setMiniappEditorId);
  const setMiniappRunnerId = useUIStore((s) => s.setMiniappRunnerId);
  const miniappsView = useUIStore((s) => s.miniappsView);
  const updateMiniappsView = useUIStore((s) => s.updateMiniappsView);

  const [query, setQuery] = useState<string>("");
  // Transient table page (1-based); reset on filter/sort/mode changes.
  const [page, setPage] = useState<number>(1);
  // The mini-app staged for deletion (awaiting confirmation), or null.
  const [pendingDelete, setPendingDelete] = useState<MiniApp | null>(null);
  // True while "Start from example" is resolving the host platform over IPC.
  const [seeding, setSeeding] = useState<boolean>(false);

  // Hydrate the store from SQLite the first time the tab mounts. Mirrors the
  // command/workflow stores' bootstrap-hydrate contract, but the mini-app
  // store has no seed step and is hydrated on demand instead — `hydrateFromDb`
  // is idempotent and swallows its own errors (it still flips `hydrated`), so
  // an unguarded call here is safe under React Strict Mode and re-mounts.
  useEffect(() => {
    void useMiniAppStore.getState().hydrateFromDb();
  }, []);

  const filtered = useMemo(
    () => miniapps.filter((ma) => matchesMiniAppQuery(ma, query, t)),
    [miniapps, query, t],
  );

  const sortOptions: ReadonlyArray<SortOption<MiniAppSortKey>> = useMemo(
    () => [
      { key: "createdAt", dir: "desc", label: t("listView.sortNewestFirst") },
      { key: "createdAt", dir: "asc", label: t("listView.sortOldestFirst") },
      { key: "name", dir: "asc", label: t("listView.sortNameAsc") },
      { key: "name", dir: "desc", label: t("listView.sortNameDesc") },
    ],
    [t],
  );

  const sorted = useMemo(
    () =>
      sortMiniApps(filtered, {
        key: miniappsView.sortKey,
        dir: miniappsView.sortDir,
      }),
    [filtered, miniappsView.sortKey, miniappsView.sortDir],
  );

  const pageResult = useMemo(
    () => paginate(sorted, page, miniappsView.pageSize),
    [sorted, page, miniappsView.pageSize],
  );

  const showTable = miniappsView.mode === "table";
  const compact = miniappsView.mode === "compact";

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
    setPage(1);
  };

  const handleCreate = (): void => {
    setMiniappEditorId(null);
    setView("miniapp-editor");
  };

  /**
   * Materialise the built-in example panels for this host.
   *
   * The seeds are otherwise a ONE-SHOT startup step (`useSeedBootstrap` runs
   * `initializeSeeds` only when the library is empty on first launch), so a
   * user who deleted them — or who joined an install that already had
   * commands — could never get a worked example back. This re-adds them on
   * demand through the normal `addMiniApp` path, so each copy gets fresh ids
   * and is persisted like any user-created mini-app.
   */
  const handleStartFromExample = (): void => {
    if (seeding) return;
    setSeeding(true);
    void (async (): Promise<void> => {
      try {
        const detected = await getPlatform();
        const platform: Platform = detected === "unknown" ? "linux" : detected;
        const seeds = buildMiniAppSeedsForPlatform(platform);
        for (const seed of seeds) addMiniApp(seed);
        Message.success(t("miniapps.exampleAdded", { count: seeds.length }));
      } catch (err: unknown) {
        // Platform detection is the only thing that can throw here; surface it
        // rather than leaving the button silently inert.
        const message = err instanceof Error ? err.message : String(err);
        Message.error(t("miniapps.exampleFailed", { message }));
      } finally {
        setSeeding(false);
      }
    })();
  };

  const handleEdit = (miniapp: MiniApp): void => {
    setMiniappEditorId(miniapp.id);
    setView("miniapp-editor");
  };

  const handleRun = (miniapp: MiniApp): void => {
    setMiniappRunnerId(miniapp.id);
    setView("miniapp-runner");
  };

  const requestDelete = (miniapp: MiniApp): void => {
    setPendingDelete(miniapp);
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    deleteMiniApp(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <>
      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={t("miniapps.searchPlaceholder")}
          value={query}
          onChange={handleSearch}
        />
        <ListControls
          sortOptions={sortOptions}
          sortKey={miniappsView.sortKey}
          sortDir={miniappsView.sortDir}
          onSortChange={(key, dir) => {
            updateMiniappsView({ sortKey: key, sortDir: dir });
            setPage(1);
          }}
          mode={miniappsView.mode}
          onModeChange={(mode) => updateMiniappsView({ mode })}
        />
      </div>

      {!hydrated ? (
        <div className="empty-state">{t("common.loading")}</div>
      ) : miniapps.length === 0 ? (
        <div className="empty-state">
          <p>{t("miniapps.empty")}</p>
          <p>{t("miniapps.emptyHint")}</p>
          <div className="miniapps-empty__actions">
            <button type="button" className="btn btn--primary" onClick={handleCreate}>
              <PlusIcon />
              {t("miniapps.createLabel")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleStartFromExample}
              disabled={seeding}
            >
              <CopyIcon />
              {t("miniapps.startFromExample")}
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">{t("miniapps.noResults")}</div>
      ) : showTable ? (
        <>
          <MiniAppTable
            miniapps={pageResult.pageItems}
            onRun={handleRun}
            onEdit={handleEdit}
          />
          <Pagination
            page={pageResult.page}
            totalPages={pageResult.totalPages}
            pageSize={miniappsView.pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              updateMiniappsView({ pageSize: size });
              setPage(1);
            }}
          />
        </>
      ) : (
        <div className={`command-list${compact ? " command-list--compact" : ""}`}>
          {sorted.map((miniapp) => (
            <MiniAppCard
              key={miniapp.id}
              miniapp={miniapp}
              onToggleFavorite={toggleFavorite}
              onDelete={requestDelete}
              onEdit={handleEdit}
              onRun={handleRun}
              compact={compact}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("miniapps.deleteConfirmTitle")}
        message={t("miniapps.deleteConfirm", {
          name: pendingDelete !== null ? getMiniAppName(pendingDelete, t) : "",
        })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

export function Library(): ReactElement {
  const { t } = useTranslation();
  const libraryTab = useUIStore((s) => s.libraryTab);
  const setLibraryTab = useUIStore((s) => s.setLibraryTab);
  const setView = useUIStore((s) => s.setView);
  const setCommandEditorTarget = useUIStore((s) => s.setCommandEditorTarget);
  const setCommandEditorDirty = useUIStore((s) => s.setCommandEditorDirty);
  const setEditorWorkflowId = useUIStore((s) => s.setEditorWorkflowId);
  const setMiniappEditorId = useUIStore((s) => s.setMiniappEditorId);

  const tabs: ReadonlyArray<{ key: LibraryTab; labelKey: string }> = [
    { key: "commands", labelKey: "workflow.tabs.commands" },
    { key: "workflows", labelKey: "workflow.tabs.workflows" },
    { key: "miniapps", labelKey: "workflow.tabs.miniapps" },
  ];

  const handleNewCommand = (): void => {
    setCommandEditorDirty(false);
    setCommandEditorTarget({ mode: "create", commandId: null });
    setView("command-editor");
  };

  const handleNewWorkflow = (): void => {
    setEditorWorkflowId(null);
    setView("editor");
  };

  const handleNewMiniApp = (): void => {
    setMiniappEditorId(null);
    setView("miniapp-editor");
  };

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("library.title")}</h1>
          <p className="view-subtitle">{t("library.subtitle")}</p>
        </div>
      </header>

      <div className="library-tabs-row">
        <div className="library-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={libraryTab === tab.key}
              className={`library-tab${libraryTab === tab.key ? " is-active" : ""}`}
              onClick={() => setLibraryTab(tab.key)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {libraryTab === "commands" ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleNewCommand}
            aria-label={t("library.newCommand")}
            title={t("library.newCommand")}
          >
            <PlusIcon />
            {t("library.newCommandLabel")}
          </button>
        ) : libraryTab === "workflows" ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleNewWorkflow}
            aria-label={t("workflow.new")}
            title={t("workflow.new")}
          >
            <PlusIcon />
            {t("workflow.newLabel")}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleNewMiniApp}
            aria-label={t("miniapps.create")}
            title={t("miniapps.create")}
          >
            <PlusIcon />
            {t("miniapps.createLabel")}
          </button>
        )}
      </div>

      {libraryTab === "commands" ? (
        <CommandsTab />
      ) : libraryTab === "workflows" ? (
        <WorkflowsTab />
      ) : (
        <MiniAppsTab />
      )}
    </div>
  );
}
