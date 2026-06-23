import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import { EditIcon } from '../icons';

/**
 * Information about the value this entry shadows (only set for entries that
 * overlap with an earlier source). Lets the modal show *what exactly* is
 * being overridden — the bare ⚠ badge is not enough.
 */
export interface EnvVarOverride {
  /** The value that would be used if this entry did not exist. */
  value: string;
  /** Where that value comes from. */
  source: 'system' | 'file';
  /** Absolute path of the file (only when `source === 'file'`). */
  filePath?: string;
}

export interface EnvVarModalEntry {
  key: string;
  value: string;
  /** Undefined for system variables — they are read-only in this modal. */
  filePath?: string;
  /**
   * If set, this entry shadows a value from another source — the modal shows
   * a dedicated "Overrides" row with the underlying value and its origin so
   * the user can compare without leaving the dialog.
   */
  override?: EnvVarOverride;
}

interface EnvVarModalProps {
  entry: EnvVarModalEntry | null;
  onClose: () => void;
  onSave: (filePath: string, key: string, value: string) => Promise<void>;
}

/**
 * Modal for inspecting and editing a single environment variable.
 *
 * - System variables (no `filePath`): key + value are read-only.
 * - File variables: key is read-only; value shows a pencil button that
 *   switches the value text into an input for inline editing.
 *
 * Portal pattern: `createPortal` → `document.body`, `.command-form__backdrop`
 * backdrop (closes on outside click), Esc closes, same modal chrome as
 * `ConfirmDialog` / `WorkflowMetaModal`.
 */
export function EnvVarModal({
  entry,
  onClose,
  onSave,
}: EnvVarModalProps): ReactElement | null {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Reset local state whenever the modal opens for a (new) entry.
  useEffect(() => {
    if (entry !== null) {
      setEditing(false);
      setDraft(entry.value);
      setSaving(false);
      // Focus the close button by default — safe, non-destructive.
      setTimeout(() => closeRef.current?.focus(), 0);
    }
  }, [entry]);

  // Auto-focus the input when edit mode activates.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (entry === null) return null;

  const isFile = entry.filePath !== undefined;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Escape exits inline value-editing (reverting the draft) but does NOT
    // close the modal — modals close only via an explicit button or backdrop.
    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      setEditing(false);
      setDraft(entry.value);
    }
  };

  const handleStartEdit = (): void => {
    setDraft(entry.value);
    setEditing(true);
  };

  const handleCancelEdit = (): void => {
    setEditing(false);
    setDraft(entry.value);
  };

  const handleSave = async (): Promise<void> => {
    if (!entry.filePath) return;
    // The key is fixed (read-only) and already came from a parsed file, so it
    // is valid by construction — no key validation needed here. Only the value
    // changes. Saving an empty value is allowed (`KEY=`).
    setSaving(true);
    try {
      await onSave(entry.filePath, entry.key, draft);
      setEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        t('envManager.writeEntryError', {
          defaultValue: 'Failed to save entry: {{msg}}',
          msg,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--meta env-var-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('envManager.varModal.title', { defaultValue: 'Variable' })}
      >
        <h2 className="command-form__title">
          {t('envManager.varModal.title', { defaultValue: 'Variable' })}
        </h2>

        <div className="env-var-modal__body">
          {/* Key row — always read-only */}
          <div className="env-var-modal__row">
            <span className="env-var-modal__label">
              {t('envManager.varModal.key', { defaultValue: 'Key' })}
            </span>
            <span className="env-var-modal__value env-var-modal__value--key">
              {entry.key}
            </span>
          </div>

          {/* Value row — editable for file vars */}
          <div className="env-var-modal__row">
            <span className="env-var-modal__label">
              {t('envManager.varModal.value', { defaultValue: 'Value' })}
            </span>
            <span className="env-var-modal__value-group">
              {editing ? (
                <>
                  <input
                    ref={inputRef}
                    type="text"
                    className="input env-var-modal__edit-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    disabled={saving}
                    aria-label={t('envManager.varModal.value', { defaultValue: 'Value' })}
                  />
                  <button
                    type="button"
                    className="btn btn--primary env-var-modal__save-btn"
                    onClick={() => void handleSave()}
                    disabled={saving}
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={handleCancelEdit}
                    disabled={saving}
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <span
                    className={
                      entry.value
                        ? 'env-var-modal__value'
                        : 'env-var-modal__value env-var-modal__value--empty'
                    }
                  >
                    {entry.value ||
                      t('envManager.files.emptyValue', { defaultValue: '(empty)' })}
                  </span>
                  {isFile && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon env-var-modal__pencil"
                      onClick={handleStartEdit}
                      aria-label={t('envManager.varModal.editValue', {
                        defaultValue: 'Edit value',
                      })}
                      title={t('envManager.varModal.editValue', {
                        defaultValue: 'Edit value',
                      })}
                    >
                      <EditIcon />
                    </button>
                  )}
                </>
              )}
            </span>
          </div>

          {/* Source file row — shown only for file vars */}
          {isFile && (
            <div className="env-var-modal__row">
              <span className="env-var-modal__label">
                {t('envManager.varModal.file', { defaultValue: 'File' })}
              </span>
              <span
                className="env-var-modal__value env-var-modal__value--path"
                title={entry.filePath}
              >
                {entry.filePath}
              </span>
            </div>
          )}

          {/* Override block — shown when this entry shadows a system var or
              an earlier .env file. Shows the underlying value + origin so the
              user understands exactly what they are replacing. */}
          {entry.override && (
            <div className="env-var-modal__override">
              <div className="env-var-modal__override-title">
                <span aria-hidden="true">⚠</span>{' '}
                {entry.override.source === 'system'
                  ? t('envManager.varModal.overridesSystem', {
                      defaultValue: 'Overrides system variable',
                    })
                  : t('envManager.varModal.overridesFile', {
                      defaultValue: 'Overrides variable from earlier file',
                    })}
              </div>
              <div className="env-var-modal__row env-var-modal__row--override">
                <span className="env-var-modal__label">
                  {t('envManager.varModal.overrideValue', {
                    defaultValue: 'Existing value',
                  })}
                </span>
                <span
                  className={
                    entry.override.value
                      ? 'env-var-modal__value'
                      : 'env-var-modal__value env-var-modal__value--empty'
                  }
                >
                  {entry.override.value ||
                    t('envManager.files.emptyValue', { defaultValue: '(empty)' })}
                </span>
              </div>
              {entry.override.source === 'file' && entry.override.filePath && (
                <div className="env-var-modal__row env-var-modal__row--override">
                  <span className="env-var-modal__label">
                    {t('envManager.varModal.overrideFile', {
                      defaultValue: 'From file',
                    })}
                  </span>
                  <span
                    className="env-var-modal__value env-var-modal__value--path"
                    title={entry.override.filePath}
                  >
                    {entry.override.filePath}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="command-form__actions">
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
