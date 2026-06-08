import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvEntry } from '../../types/envManager';
import type { OverrideInfo } from '../../utils/envVars';
import { basename } from '../../utils/envVars';
import { TrashIcon, ViewIcon } from '../icons';

interface EnvVarRowProps {
  entry: EnvEntry;
  /**
   * What this entry shadows, or `null` if nothing. Drives the conflict
   * badge AND its tooltip (the bare ⚠ from before was not enough — the user
   * could not tell what was being overridden without opening the modal).
   */
  override: OverrideInfo | null;
  /** Open the detail/edit modal for this entry. */
  onOpen: () => void;
  /** Delete this entry from its file. */
  onDelete: () => void;
}

/**
 * A single `.env` file variable row.
 *
 * Editing is NOT inline here (D5): the value is a button that opens the shared
 * {@link EnvVarModal}, which is the single place a file variable is edited.
 * The row only views, opens, and deletes.
 */
export function EnvVarRow({
  entry,
  override,
  onOpen,
  onDelete,
}: EnvVarRowProps): ReactElement {
  const { t } = useTranslation();
  const openLabel = t('envManager.varModal.open', { defaultValue: 'View variable' });

  // The conflict tooltip shows the OVERRIDDEN value and its origin verbatim,
  // so the user can compare at a glance without opening the modal. Empty
  // values are rendered as the localised "(empty)" placeholder.
  const conflictTitle = (() => {
    if (!override) return undefined;
    const valueText =
      override.value ||
      t('envManager.files.emptyValue', { defaultValue: '(empty)' });
    if (override.source === 'system') {
      return t('envManager.conflictSystemDetailed', {
        defaultValue: 'Overrides system value: {{value}}',
        value: valueText,
      });
    }
    // file override
    const fileLabel = override.filePath ? basename(override.filePath) : '?';
    return t('envManager.conflictFileDetailed', {
      defaultValue: 'Overrides {{value}} from {{file}}',
      value: valueText,
      file: fileLabel,
    });
  })();

  return (
    <li className="env-manager__var-row">
      <button
        type="button"
        className="btn btn--ghost btn--icon env-manager__view-btn"
        onClick={onOpen}
        aria-label={openLabel}
        title={openLabel}
      >
        <ViewIcon />
      </button>
      <span className="env-manager__var-key">{entry.key}</span>
      <button
        type="button"
        className="env-manager__var-value env-manager__var-value--editable"
        onClick={onOpen}
        title={t('envManager.files.clickToEdit', { defaultValue: 'Click to edit' })}
      >
        {entry.value || (
          <span className="env-manager__var-value--empty">
            {t('envManager.files.emptyValue', { defaultValue: '(empty)' })}
          </span>
        )}
      </button>
      {override && (
        <span
          className="env-manager__conflict-badge"
          title={conflictTitle}
          aria-label={conflictTitle}
        >
          ⚠
        </span>
      )}
      <button
        type="button"
        className="btn btn--ghost btn--icon env-manager__delete-entry"
        onClick={onDelete}
        aria-label={t('envManager.files.deleteEntry', { defaultValue: 'Delete entry' })}
        title={t('envManager.files.deleteEntry', { defaultValue: 'Delete entry' })}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
