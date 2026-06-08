import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvEntry, EnvFileSummary } from '../../types/envManager';
import { basename, findOverride } from '../../utils/envVars';
import { TrashIcon } from '../icons';
import { EnvVarRow } from './EnvVarRow';

interface EnvFileCardProps {
  filePath: string;
  summary: EnvFileSummary | undefined;
  /** All system vars, used to detect conflicts. */
  systemVars: Record<string, string>;
  /** Full registration order — used to resolve "earlier file" conflicts. */
  envFilePaths: readonly string[];
  /** All file summaries (path → summary) — same purpose as above. */
  envFileSummaries: Record<string, EnvFileSummary>;
  onRemoveFile: () => void;
  onOpenEntry: (entry: EnvEntry) => void;
  onDeleteEntry: (key: string) => void;
}

/**
 * One registered `.env` file: its header (name, path, remove button) and the
 * list of its variable rows. Parse errors and the empty-file case are rendered
 * inline. Conflict detection delegates to {@link findOverride} so the badge in
 * the row and the "Overrides" block in the modal agree on what is shadowed.
 */
export function EnvFileCard({
  filePath,
  summary,
  systemVars,
  envFilePaths,
  envFileSummaries,
  onRemoveFile,
  onOpenEntry,
  onDeleteEntry,
}: EnvFileCardProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="env-manager__file-card">
      <div className="env-manager__file-header">
        <span className="env-manager__file-name" title={filePath}>
          {basename(filePath)}
        </span>
        <span className="env-manager__file-path">{filePath}</span>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onRemoveFile}
          aria-label={t('envManager.files.removeFile', { defaultValue: 'Remove file' })}
          title={t('envManager.files.removeFile', { defaultValue: 'Remove file' })}
        >
          <TrashIcon />
        </button>
      </div>

      {summary?.error ? (
        <p className="env-manager__file-error">
          {t('envManager.files.parseError', {
            defaultValue: 'Error: {{error}}',
            error: summary.error,
          })}
        </p>
      ) : summary && summary.entries.length === 0 ? (
        <p className="env-manager__file-empty">
          {t('envManager.files.noEntries', {
            defaultValue: 'This file has no key=value entries.',
          })}
        </p>
      ) : (
        <ul className="env-manager__var-list">
          {summary?.entries.map((entry) => (
            <EnvVarRow
              key={entry.key}
              entry={entry}
              override={findOverride(
                entry.key,
                filePath,
                systemVars,
                envFilePaths,
                envFileSummaries,
              )}
              onOpen={() => onOpenEntry(entry)}
              onDelete={() => onDeleteEntry(entry.key)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
