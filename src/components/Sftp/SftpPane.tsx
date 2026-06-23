import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CopyIcon,
  CutIcon,
  FileIcon,
  FolderIcon,
  PasteIcon,
  PlusIcon,
  RerunIcon,
  TrashIcon,
} from '../icons';
import { useContextMenu } from '../ContextMenu';
import type { ContextMenuEntry } from '../ContextMenu';
import {
  joinPath,
  parentDir,
  selectPane,
  useSftpStore,
  type PaneEntry,
} from '../../stores/sftpStore';
import { DRAG_MIME, type DragPayload, type PaneSide } from '../../types/sftp';
import { listLocalDir, sftpListDir } from '../../services/sftpService';

/** Hoisted stable empty list so the dismissed branch never returns a fresh
 *  array (a new `[]` each render would defeat memo/render-bailout). */
const EMPTY_SUGGESTIONS: string[] = [];

/**
 * Split a path the user is typing into the directory to list and the partial
 * trailing segment to filter by. A trailing `/` means "list this directory,
 * no filter"; otherwise the last segment is the in-progress leaf.
 *   `/var/lo`  -> { dir: '/var',  leaf: 'lo' }
 *   `/var/`    -> { dir: '/var',  leaf: '' }
 *   `/`        -> { dir: '/',     leaf: '' }
 */
function splitTypedPath(text: string): { dir: string; leaf: string } | null {
  if (!text.startsWith('/')) return null;
  const lastSlash = text.lastIndexOf('/');
  const dir = lastSlash === 0 ? '/' : text.slice(0, lastSlash);
  const leaf = text.slice(lastSlash + 1);
  return { dir, leaf };
}

/**
 * Live directory completion for the path field. As the user types an absolute
 * path it lists the typed parent directory (local via `list_local_dir`, remote
 * via the pane's alias over SFTP) and returns the subdirectory names that match
 * the partial trailing segment. Listing is debounced and the latest request
 * wins, so out-of-order responses can't clobber fresher suggestions. IO errors
 * (e.g. an unreadable directory) yield an empty list — never a thrown error.
 */
function usePathSuggestions(
  side: PaneSide,
  alias: string | null,
  draft: string,
  enabled: boolean,
): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  /** Monotonic request id so a slow response can't overwrite a newer one. */
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setSuggestions([]);
      return;
    }
    const split = splitTypedPath(draft);
    if (split === null) {
      setSuggestions([]);
      return;
    }
    const { dir, leaf } = split;
    const id = ++requestId.current;
    const handle = setTimeout(() => {
      const list = side === 'remote'
        ? (alias === null ? null : sftpListDir(alias, dir))
        : listLocalDir(dir);
      if (list === null) {
        setSuggestions([]);
        return;
      }
      void list
        .then((listing) => {
          if (id !== requestId.current) return;
          const lower = leaf.toLowerCase();
          const dirs = listing.entries
            .filter((e) => e.kind === 'dir' && e.name.toLowerCase().startsWith(lower))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            .slice(0, 50);
          setSuggestions(dirs);
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setSuggestions([]);
        });
    }, 150);
    return () => clearTimeout(handle);
  }, [side, alias, draft, enabled]);

  return suggestions;
}

interface SftpPaneProps {
  side: PaneSide;
  /** Header title: `localhost` for the local pane, the alias for remote. */
  title: string;
  /** Prompt the user for a new folder name (returns null on cancel). */
  onPromptNewFolder: (side: PaneSide) => void;
  /** Prompt the user to rename `entry` (returns null on cancel). */
  onPromptRename: (side: PaneSide, entry: PaneEntry) => void;
  /** Confirm + perform deletion of the given entries. */
  onRequestDelete: (side: PaneSide, entries: PaneEntry[]) => void;
}

/**
 * One pane (local or remote) of the SFTP file manager: a header with the host
 * name + breadcrumb, an action row (copy / cut / paste / delete / new folder /
 * refresh), and the directory listing. Rows are drag sources and directories +
 * the pane body are drop targets, so a file can be dragged to the other pane
 * to COPY it (drag-and-drop never moves; use cut + paste for a move). A
 * "show hidden" toggle reveals dotfiles (off by default).
 *
 * All styling uses the `sftp-*` class family in `theme.css`; no inline styles.
 */
export function SftpPane({
  side,
  title,
  onPromptNewFolder,
  onPromptRename,
  onRequestDelete,
}: SftpPaneProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();

  const pane = useSftpStore((s) => selectPane(s, side));
  const alias = useSftpStore((s) => s.alias);
  const clipboard = useSftpStore((s) => s.clipboard);
  const isTransferring = useSftpStore((s) => s.isTransferring);
  const navigate = useSftpStore((s) => s.navigate);
  const refresh = useSftpStore((s) => s.refresh);
  const setSelection = useSftpStore((s) => s.setSelection);
  const copy = useSftpStore((s) => s.copy);
  const cut = useSftpStore((s) => s.cut);
  const paste = useSftpStore((s) => s.paste);
  const setDrag = useSftpStore((s) => s.setDrag);
  const transfer = useSftpStore((s) => s.transfer);

  const cwd = pane.cwd;
  const selection = pane.selection;

  /** Name of the directory row currently hovered during a drag (`''`=body). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /**
   * Whether hidden entries (dotfiles) are shown in this pane. Off by default;
   * the backend always returns dotfiles, so this is a pure UI filter. Per-pane
   * (local and remote toggle independently).
   */
  const [showHidden, setShowHidden] = useState(false);

  /**
   * The editable path field's text. It mirrors `cwd` but is held locally so the
   * user can type a destination freely; it re-syncs whenever `cwd` changes
   * (navigation by click, refresh, or a failed manual jump that left `cwd`
   * unchanged). The path is only committed on Enter.
   */
  const [pathDraft, setPathDraft] = useState(cwd ?? '');
  /** Whether the path field is focused — gates the suggestion dropdown. */
  const [pathFocused, setPathFocused] = useState(false);
  /**
   * Set true after Enter/Escape to keep the dropdown closed until the user
   * deliberately re-opens it by clicking/focusing the field again. Without
   * this, navigating on Enter would re-sync the draft and immediately re-open
   * the list while the field is still focused.
   */
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  /** Index of the highlighted suggestion (-1 = none, type-to-go applies). */
  const [suggestActive, setSuggestActive] = useState(-1);
  // Re-sync the draft to the canonical `cwd` whenever it changes (navigation by
  // click, refresh, or a completed manual jump) — BUT never while the field is
  // focused, so a background refresh of this pane can't wipe what the user is
  // actively typing. On blur the draft is reconciled back to `cwd` (below).
  useEffect(() => {
    if (!pathFocused) setPathDraft(cwd ?? '');
  }, [cwd, pathFocused]);

  const rawSuggestions = usePathSuggestions(side, alias, pathDraft, pathFocused && !suggestDismissed);
  const suggestions = suggestDismissed ? EMPTY_SUGGESTIONS : rawSuggestions;
  const showSuggestions = pathFocused && !suggestDismissed && suggestions.length > 0;

  // A new suggestion set invalidates the previous highlight.
  useEffect(() => {
    setSuggestActive(-1);
  }, [suggestions]);

  /**
   * Drill into a clicked/selected folder: replace the typed leaf with `name`
   * and append a trailing `/` so the dropdown's next round lists THAT folder's
   * children rather than the just-picked folder itself. This only edits the
   * draft — it does not commit navigation (Enter does that).
   */
  const completeWith = useCallback(
    (name: string): void => {
      const split = splitTypedPath(pathDraft);
      const base = split === null ? pathDraft : split.dir;
      const next = joinPath(base, name);
      setPathDraft(next.endsWith('/') ? next : `${next}/`);
      setSuggestActive(-1);
    },
    [pathDraft],
  );

  const handlePathKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'ArrowDown' && showSuggestions) {
        e.preventDefault();
        setSuggestActive((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp' && showSuggestions) {
        e.preventDefault();
        setSuggestActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (showSuggestions && suggestActive >= 0) {
          completeWith(suggestions[suggestActive]);
          return;
        }
        // Commit navigation and close the dropdown until re-focused. Guard the
        // edge cases: an empty draft, a draft equal to the current dir (no-op),
        // and a pane that hasn't loaded yet (cwd === null → nothing to navigate
        // relative to, and the input is disabled anyway).
        setSuggestDismissed(true);
        const target = pathDraft.trim();
        if (cwd !== null && target !== '' && target !== cwd) {
          void navigate(side, target);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Close the dropdown; if it was already closed, revert and blur.
        if (showSuggestions) {
          setSuggestActive(-1);
          setSuggestDismissed(true);
        } else {
          setPathDraft(cwd ?? '');
          e.currentTarget.blur();
        }
      }
    },
    [completeWith, cwd, navigate, pathDraft, showSuggestions, suggestActive, suggestions, side],
  );

  /**
   * Entries actually shown: all of them when {@link showHidden} is on, otherwise
   * only non-hidden ones (names not starting with `.`). The backend always
   * returns dotfiles, so hiding is done here.
   */
  const visibleEntries = useMemo(
    () => (showHidden ? pane.entries : pane.entries.filter((e) => !e.name.startsWith('.'))),
    [pane.entries, showHidden],
  );

  /** Number of hidden entries currently filtered out (for the toggle title). */
  const hiddenCount = useMemo(
    () => pane.entries.reduce((n, e) => (e.name.startsWith('.') ? n + 1 : n), 0),
    [pane.entries],
  );

  /** Absolute paths of the current selection. */
  const selectedPaths = useMemo(
    () => (cwd === null ? [] : selection.map((name) => joinPath(cwd, name))),
    [cwd, selection],
  );

  const hasSelection = selection.length > 0;
  const canPaste = clipboard !== null && cwd !== null && !isTransferring;

  const handleOpen = useCallback(
    (entry: PaneEntry): void => {
      if (cwd === null) return;
      if (entry.kind === 'dir') {
        void navigate(side, joinPath(cwd, entry.name));
      }
    },
    [cwd, navigate, side],
  );

  const handleRowClick = useCallback(
    (entry: PaneEntry, e: ReactMouseEvent): void => {
      // Ctrl/Cmd toggles; plain click replaces the selection.
      if (e.ctrlKey || e.metaKey) {
        const next = selection.includes(entry.name)
          ? selection.filter((n) => n !== entry.name)
          : [...selection, entry.name];
        setSelection(side, next);
      } else {
        setSelection(side, [entry.name]);
      }
    },
    [selection, setSelection, side],
  );

  const handleUp = useCallback((): void => {
    if (cwd === null) return;
    void navigate(side, parentDir(cwd));
  }, [cwd, navigate, side]);

  // --- Drag and drop ------------------------------------------------------

  const handleDragStart = useCallback(
    (entry: PaneEntry, e: ReactDragEvent): void => {
      if (cwd === null) return;
      // Drag the whole selection if the dragged row is part of it; otherwise
      // drag just this row (and make it the selection).
      const paths = selection.includes(entry.name)
        ? selectedPaths
        : [joinPath(cwd, entry.name)];
      if (!selection.includes(entry.name)) {
        setSelection(side, [entry.name]);
      }
      const payload: DragPayload = { side, paths };
      setDrag(payload);
      // Copy-only DnD; advertise just `copy` so the browser shows the copy
      // cursor and never the move affordance.
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
      // Use the dragged ROW itself as the drag image, anchored under the cursor.
      // Without an explicit drag image the browser snapshots a translucent
      // region that can bleed in text rendered behind the modal — the reported
      // "ghost text" artifact. Pinning it to the row gives a clean, opaque chip.
      const row = e.currentTarget;
      if (row instanceof HTMLElement && typeof e.dataTransfer.setDragImage === 'function') {
        e.dataTransfer.setDragImage(row, 16, 16);
      }
    },
    [cwd, selection, selectedPaths, setDrag, setSelection, side],
  );

  const handleDragEnd = useCallback((): void => {
    setDrag(null);
    setDropTarget(null);
  }, [setDrag]);

  const readDragPayload = (e: ReactDragEvent): DragPayload | null => {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (raw === '') return useSftpStore.getState().drag;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return useSftpStore.getState().drag;
    }
  };

  const allowDrop = (e: ReactDragEvent): void => {
    // Only react to our own in-app drags.
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    // Drag-and-drop always COPIES (never moves) — the source is left intact.
    e.dataTransfer.dropEffect = 'copy';
  };

  const performDrop = useCallback(
    (targetDir: string, e: ReactDragEvent): void => {
      const payload = readDragPayload(e);
      setDrag(null);
      setDropTarget(null);
      if (payload === null || payload.paths.length === 0) return;
      // Drag-and-drop is always a copy; the source is never deleted. (Use
      // cut + paste from the context menu for an explicit move.)
      void transfer({
        fromSide: payload.side,
        toSide: side,
        paths: payload.paths,
        toDir: targetDir,
        mode: 'copy',
      });
    },
    [setDrag, side, transfer],
  );

  const handleDropOnEntry = useCallback(
    (entry: PaneEntry, e: ReactDragEvent): void => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      if (cwd === null || entry.kind !== 'dir') return;
      performDrop(joinPath(cwd, entry.name), e);
    },
    [cwd, performDrop],
  );

  const handleDropOnBody = useCallback(
    (e: ReactDragEvent): void => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      if (cwd === null) return;
      performDrop(cwd, e);
    },
    [cwd, performDrop],
  );

  // --- Actions ------------------------------------------------------------

  const doCopy = useCallback(() => {
    if (selectedPaths.length > 0) copy(side, selectedPaths);
  }, [copy, selectedPaths, side]);

  const doCut = useCallback(() => {
    if (selectedPaths.length > 0) cut(side, selectedPaths);
  }, [cut, selectedPaths, side]);

  const doPaste = useCallback(() => {
    if (cwd !== null) void paste(side, cwd);
  }, [cwd, paste, side]);

  const doDelete = useCallback(() => {
    const entries = pane.entries.filter((en) => selection.includes(en.name));
    if (entries.length > 0) onRequestDelete(side, entries);
  }, [onRequestDelete, pane.entries, selection, side]);

  /** Open the "etc file/dir actions" menu at the given screen coordinates. */
  const openActionsMenu = useCallback(
    (clientX: number, clientY: number, entry: PaneEntry | null): void => {
      const items: ContextMenuEntry[] = [];
      if (entry !== null) {
        items.push({
          id: 'rename',
          label: t('sftp.actions.rename', { defaultValue: 'Rename' }),
          onSelect: () => onPromptRename(side, entry),
        });
      }
      items.push(
        {
          id: 'copy',
          label: t('sftp.actions.copy', { defaultValue: 'Copy' }),
          disabled: !hasSelection,
          onSelect: doCopy,
        },
        {
          id: 'cut',
          label: t('sftp.actions.cut', { defaultValue: 'Cut' }),
          disabled: !hasSelection,
          onSelect: doCut,
        },
        {
          id: 'paste',
          label: t('sftp.actions.paste', { defaultValue: 'Paste' }),
          disabled: !canPaste,
          onSelect: doPaste,
        },
        { id: 'div1', divider: true },
        {
          id: 'newFolder',
          label: t('sftp.actions.newFolder', { defaultValue: 'New folder' }),
          disabled: cwd === null,
          onSelect: () => onPromptNewFolder(side),
        },
        {
          id: 'delete',
          label: t('sftp.actions.delete', { defaultValue: 'Delete' }),
          danger: true,
          disabled: !hasSelection,
          onSelect: doDelete,
        },
      );
      show({ event: { clientX, clientY, preventDefault: () => {} }, items });
    },
    [
      canPaste,
      cwd,
      doCopy,
      doCut,
      doDelete,
      doPaste,
      hasSelection,
      onPromptNewFolder,
      onPromptRename,
      show,
      side,
      t,
    ],
  );

  const handleRowContextMenu = useCallback(
    (entry: PaneEntry, e: ReactMouseEvent): void => {
      e.preventDefault();
      if (!selection.includes(entry.name)) setSelection(side, [entry.name]);
      openActionsMenu(e.clientX, e.clientY, entry);
    },
    [openActionsMenu, selection, setSelection, side],
  );

  return (
    <section className="sftp-pane" aria-label={title}>
      <header className="sftp-pane__header">
        <span className="sftp-pane__host">{title}</span>
        <div className="sftp-pane__path-wrap">
          <input
            type="text"
            className="sftp-pane__path"
            value={pathDraft}
            title={cwd ?? ''}
            spellCheck={false}
            autoComplete="off"
            disabled={cwd === null}
            placeholder={cwd === null ? '—' : undefined}
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls={`sftp-path-suggest-${side}`}
            onChange={(e) => {
              setPathDraft(e.target.value);
              // Typing re-opens a dropdown that Enter/Escape had dismissed.
              setSuggestDismissed(false);
            }}
            onKeyDown={handlePathKeyDown}
            onFocus={() => {
              setPathFocused(true);
              setSuggestDismissed(false);
            }}
            onMouseDown={() => setSuggestDismissed(false)}
            // Delay so an onMouseDown on a suggestion fires before we hide it.
            onBlur={() => setTimeout(() => setPathFocused(false), 120)}
            aria-label={t('sftp.pathLabel', { defaultValue: 'Current path (Enter to go)' })}
          />
          {showSuggestions && (
            <ul
              id={`sftp-path-suggest-${side}`}
              className="sftp-pane__path-suggest"
              role="listbox"
              aria-label={t('sftp.pathSuggestLabel', { defaultValue: 'Folders' })}
            >
              {suggestions.map((name, idx) => (
                <li
                  key={name}
                  className={
                    'sftp-pane__path-option' +
                    (idx === suggestActive ? ' sftp-pane__path-option--active' : '')
                  }
                  role="option"
                  aria-selected={idx === suggestActive}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    completeWith(name);
                  }}
                  onMouseEnter={() => setSuggestActive(idx)}
                >
                  <span className="sftp-pane__path-option-icon">
                    <FolderIcon />
                  </span>
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <div className="sftp-pane__toolbar">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={doCopy}
          disabled={!hasSelection}
          aria-label={t('sftp.actions.copy', { defaultValue: 'Copy' })}
          title={t('sftp.actions.copy', { defaultValue: 'Copy' })}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={doCut}
          disabled={!hasSelection}
          aria-label={t('sftp.actions.cut', { defaultValue: 'Cut' })}
          title={t('sftp.actions.cut', { defaultValue: 'Cut' })}
        >
          <CutIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={doPaste}
          disabled={!canPaste}
          aria-label={t('sftp.actions.paste', { defaultValue: 'Paste' })}
          title={t('sftp.actions.paste', { defaultValue: 'Paste' })}
        >
          <PasteIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={doDelete}
          disabled={!hasSelection}
          aria-label={t('sftp.actions.delete', { defaultValue: 'Delete' })}
          title={t('sftp.actions.delete', { defaultValue: 'Delete' })}
        >
          <TrashIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => onPromptNewFolder(side)}
          disabled={cwd === null}
          aria-label={t('sftp.actions.newFolder', { defaultValue: 'New folder' })}
          title={t('sftp.actions.newFolder', { defaultValue: 'New folder' })}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => void refresh(side)}
          disabled={cwd === null}
          aria-label={t('sftp.actions.refresh', { defaultValue: 'Refresh' })}
          title={t('sftp.actions.refresh', { defaultValue: 'Refresh' })}
        >
          <RerunIcon />
        </button>
        <label
          className="sftp-pane__hidden-toggle"
          title={t('sftp.showHiddenHint', {
            defaultValue: '{{count}} hidden item(s)',
            count: hiddenCount,
          })}
        >
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => {
              const next = e.target.checked;
              setShowHidden(next);
              // Hiding dotfiles must not leave invisible entries selected (a
              // delete/copy would then act on something the user can't see).
              if (!next && selection.some((n) => n.startsWith('.'))) {
                setSelection(
                  side,
                  selection.filter((n) => !n.startsWith('.')),
                );
              }
            }}
            disabled={cwd === null}
          />
          <span>{t('sftp.showHidden', { defaultValue: 'Show hidden' })}</span>
        </label>
      </div>

      <div
        className={
          'sftp-pane__body' + (dropTarget === '' ? ' is-drop-target' : '')
        }
        onDragOver={(e) => {
          allowDrop(e);
          // Only claim the body ('' = copy into the current dir) when the
          // pointer is over the body itself, NOT a child row. A directory row's
          // own onDragOver (which sets its name as the target) bubbles up here;
          // without this guard the body would immediately overwrite it with ''.
          if (e.target === e.currentTarget && e.dataTransfer.types.includes(DRAG_MIME)) {
            setDropTarget('');
          }
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the body itself, not a child row.
          if (e.target === e.currentTarget) setDropTarget(null);
        }}
        onDrop={handleDropOnBody}
      >
        {dropTarget === '' && (
          <div className="sftp-pane__drop-hint" aria-hidden="true">
            {t('sftp.dropHere', { defaultValue: 'Copy here' })}
          </div>
        )}
        {pane.isLoading ? (
          <p className="empty-state">{t('common.loading')}</p>
        ) : pane.error !== null ? (
          <p className="sftp-pane__error">{pane.error}</p>
        ) : (
          <ul className="sftp-pane__list">
            {cwd !== null && (
              <li
                className="sftp-row sftp-row--up"
                onDoubleClick={handleUp}
                onDragOver={allowDrop}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  performDrop(parentDir(cwd), e);
                }}
              >
                <span className="sftp-row__icon">
                  <FolderIcon />
                </span>
                <span className="sftp-row__name">..</span>
              </li>
            )}
            {visibleEntries.map((entry) => {
              const isSelected = selection.includes(entry.name);
              const isDir = entry.kind === 'dir';
              const isDropTarget = isDir && dropTarget === entry.name;
              const className =
                'sftp-row' +
                (isSelected ? ' is-selected' : '') +
                (isDir ? ' sftp-row--dir' : '') +
                (isDropTarget ? ' sftp-row--drop-target' : '');
              return (
                <li
                  key={entry.name}
                  className={className}
                  draggable
                  onClick={(e) => handleRowClick(entry, e)}
                  onDoubleClick={() => handleOpen(entry)}
                  onContextMenu={(e) => handleRowContextMenu(entry, e)}
                  onDragStart={(e) => handleDragStart(entry, e)}
                  onDragEnd={handleDragEnd}
                  onDragOver={
                    isDir
                      ? (e) => {
                          allowDrop(e);
                          if (e.dataTransfer.types.includes(DRAG_MIME)) {
                            setDropTarget(entry.name);
                          }
                        }
                      : undefined
                  }
                  onDragLeave={
                    isDir
                      ? (e) => {
                          if (e.target === e.currentTarget) setDropTarget(null);
                        }
                      : undefined
                  }
                  onDrop={isDir ? (e) => handleDropOnEntry(entry, e) : undefined}
                >
                  <span className="sftp-row__icon">
                    {isDir ? <FolderIcon /> : <FileIcon />}
                  </span>
                  <span className="sftp-row__name">{entry.name}</span>
                  {isDropTarget ? (
                    <span className="sftp-row__drop-hint">
                      {t('sftp.dropToFolder', { defaultValue: 'Copy to this folder' })}
                    </span>
                  ) : (
                    <span className="sftp-row__size">
                      {isDir ? '' : formatSize(entry.size)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Human-readable byte size, or empty for a directory / unknown size. */
function formatSize(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
