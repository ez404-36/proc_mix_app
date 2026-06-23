import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { homeDir } from '@tauri-apps/api/path';
import { ConfirmDialog } from '../ConfirmDialog';
import { CancelIcon } from '../icons';
import { SftpPane } from './SftpPane';
import { SftpTransferLog } from './SftpTransferLog';
import {
  joinPath,
  selectPane,
  useSftpStore,
  type PaneEntry,
} from '../../stores/sftpStore';
import type { PaneSide } from '../../types/sftp';

interface SftpManagerProps {
  /** The remote host alias to open a session against. */
  alias: string;
  onClose: () => void;
}

/** A pending name prompt (new folder or rename). */
type NamePrompt =
  | { kind: 'newFolder'; side: PaneSide }
  | { kind: 'rename'; side: PaneSide; entry: PaneEntry };

/** A pending delete confirmation. */
interface DeleteRequest {
  side: PaneSide;
  entries: PaneEntry[];
}

/**
 * The dual-pane SFTP file manager modal. The left pane is always the local
 * machine; the right pane is the remote `alias`. Both panes share one store, so
 * copy/cut/paste and drag-and-drop work across them. Files can be dragged
 * between panes to COPY (drag-and-drop never moves). While a drag is in flight a
 * green "Copy" badge sits on the divider between the panes.
 *
 * Portals to `document.body` and follows the app modal conventions
 * (`command-form__backdrop`, Esc to close, `role="dialog"`).
 */
export function SftpManager({ alias, onClose }: SftpManagerProps): ReactElement {
  const { t } = useTranslation();

  const openSession = useSftpStore((s) => s.openSession);
  const closeSession = useSftpStore((s) => s.closeSession);
  const makeDir = useSftpStore((s) => s.makeDir);
  const renameEntry = useSftpStore((s) => s.rename);
  const removeEntries = useSftpStore((s) => s.remove);
  const isTransferring = useSftpStore((s) => s.isTransferring);
  const isDragging = useSftpStore((s) => s.drag !== null);
  const localPane = useSftpStore((s) => selectPane(s, 'local'));
  const remotePane = useSftpStore((s) => selectPane(s, 'remote'));

  const [prompt, setPrompt] = useState<NamePrompt | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);

  // Open the session on mount; close it on unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let localHome = '/';
      try {
        localHome = await homeDir();
      } catch {
        localHome = '/';
      }
      if (cancelled) return;
      // Remote home: start at '.', the login directory. The backend resolves
      // this to its absolute path (via `pwd`) and returns it as the pane's cwd,
      // so navigation ("go up", path joins) operates on a real absolute path.
      await openSession(alias, localHome, '.');
    })();
    return () => {
      cancelled = true;
      closeSession();
    };
  }, [alias, openSession, closeSession]);

  // The file-transfer manager deliberately does NOT close on a backdrop click
  // (an accidental outside click during a transfer would be costly) and never
  // closes on Escape. It closes only via the explicit close button. The
  // backdrop is still rendered for layout/focus containment.

  // --- Prompt handlers (passed down to each pane) -------------------------

  const handlePromptNewFolder = useCallback((side: PaneSide): void => {
    setPromptValue('');
    setPrompt({ kind: 'newFolder', side });
  }, []);

  const handlePromptRename = useCallback((side: PaneSide, entry: PaneEntry): void => {
    setPromptValue(entry.name);
    setPrompt({ kind: 'rename', side, entry });
  }, []);

  const handleRequestDelete = useCallback((side: PaneSide, entries: PaneEntry[]): void => {
    setDeleteRequest({ side, entries });
  }, []);

  const closePrompt = useCallback((): void => {
    setPrompt(null);
    setPromptValue('');
  }, []);

  const submitPrompt = useCallback((): void => {
    if (prompt === null) return;
    const value = promptValue.trim();
    if (value === '') return;
    if (prompt.kind === 'newFolder') {
      void makeDir(prompt.side, value);
    } else {
      const pane = prompt.side === 'local' ? localPane : remotePane;
      if (pane.cwd !== null) {
        const from = joinPath(pane.cwd, prompt.entry.name);
        const to = joinPath(pane.cwd, value);
        if (from !== to) void renameEntry(prompt.side, from, to);
      }
    }
    closePrompt();
  }, [closePrompt, localPane, makeDir, prompt, promptValue, remotePane, renameEntry]);

  const confirmDelete = useCallback((): void => {
    if (deleteRequest === null) return;
    const { side, entries } = deleteRequest;
    const pane = side === 'local' ? localPane : remotePane;
    setDeleteRequest(null);
    if (pane.cwd === null) return;
    const items = entries.map((en) => ({
      path: joinPath(pane.cwd as string, en.name),
      isDir: en.kind === 'dir',
    }));
    void removeEntries(side, items);
  }, [deleteRequest, localPane, remotePane, removeEntries]);

  const titleId = 'sftp-manager-title';

  const modal = (
    <div className="command-form__backdrop" role="presentation">
      <div
        className="command-form command-form--sftp sftp-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header sftp-manager__header">
          <h2 id={titleId} className="command-form__title">
            {t('sftp.title', { defaultValue: 'Files — {{alias}}', alias })}
          </h2>
          {isTransferring && (
            <span className="sftp-manager__status" role="status">
              {t('sftp.transferring', { defaultValue: 'Transferring…' })}
            </span>
          )}
          <SftpTransferLog />
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            title={t('common.close', { defaultValue: 'Close' })}
          >
            <CancelIcon />
          </button>
        </div>

        <div className="sftp-manager__panes">
          <SftpPane
            side="local"
            title={t('sftp.localhost', { defaultValue: 'localhost' })}
            onPromptNewFolder={handlePromptNewFolder}
            onPromptRename={handlePromptRename}
            onRequestDelete={handleRequestDelete}
          />
          <SftpPane
            side="remote"
            title={alias}
            onPromptNewFolder={handlePromptNewFolder}
            onPromptRename={handlePromptRename}
            onRequestDelete={handleRequestDelete}
          />
          {/* Green "Copy" badge on the divider, shown only during a drag, so the
              user knows drag-and-drop copies (never moves). */}
          {isDragging && (
            <span className="sftp-manager__drag-badge" role="status">
              {t('sftp.dragCopyBadge', { defaultValue: 'Copy' })}
            </span>
          )}
        </div>
      </div>

      {prompt !== null && (
        <NamePromptDialog
          title={
            prompt.kind === 'newFolder'
              ? t('sftp.newFolderTitle', { defaultValue: 'New folder' })
              : t('sftp.renameTitle', { defaultValue: 'Rename' })
          }
          value={promptValue}
          onChange={setPromptValue}
          onSubmit={submitPrompt}
          onCancel={closePrompt}
        />
      )}

      <ConfirmDialog
        open={deleteRequest !== null}
        title={t('sftp.deleteTitle', { defaultValue: 'Delete' })}
        message={t('sftp.deleteConfirm', {
          defaultValue: 'Delete {{count}} item(s)? This cannot be undone.',
          count: deleteRequest?.entries.length ?? 0,
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteRequest(null)}
      />
    </div>
  );

  return createPortal(modal, document.body);
}

interface NamePromptDialogProps {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** A small single-text-field modal for "new folder" / "rename". */
function NamePromptDialog({
  title,
  value,
  onChange,
  onSubmit,
  onCancel,
}: NamePromptDialogProps): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Enter submits; Escape intentionally does NOT close (modals close only via
    // the explicit Cancel button or a backdrop click).
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    }
  };

  const handleBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={handleKeyDown}
      >
        <h2 className="command-form__title">{title}</h2>
        <div className="command-form__body">
          <input
            ref={inputRef}
            type="text"
            className="input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={title}
          />
        </div>
        <div className="command-form__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSubmit}
            disabled={value.trim() === ''}
          >
            {t('common.confirm', { defaultValue: 'OK' })}
          </button>
        </div>
      </div>
    </div>
  );
}
