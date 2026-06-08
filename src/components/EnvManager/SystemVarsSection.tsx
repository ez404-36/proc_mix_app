import { useMemo, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvEntry } from '../../types/envManager';
import { isSensitiveKey } from '../../utils/envVars';
import { useSensitiveReveal } from '../../hooks/useSensitiveReveal';
import { ViewIcon } from '../icons';

interface SystemVarsSectionProps {
  /** Count for the section header. */
  total: number;
  /** All system entries (already filtered to `source === 'system'`). */
  entries: EnvEntry[];
  onOpenEntry: (entry: EnvEntry) => void;
}

/**
 * Collapsible, searchable list of the inherited process environment
 * variables. Values for sensitive keys are masked with a per-key reveal
 * toggle. Read-only — opening a system variable shows it in the modal but
 * never offers an edit (you cannot rewrite the process environment at runtime).
 */
export function SystemVarsSection({
  total,
  entries,
  onOpenEntry,
}: SystemVarsSectionProps): ReactElement {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const [search, setSearch] = useState('');
  const reveal = useSensitiveReveal();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === '') return entries;
    return entries.filter(
      (e) =>
        e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q),
    );
  }, [entries, search]);

  const searchLabel = t('envManager.systemVars.searchPlaceholder', {
    defaultValue: 'Filter by name or value…',
  });
  const openLabel = t('envManager.varModal.open', { defaultValue: 'View variable' });

  return (
    <section className="view-section">
      <div className="env-manager__section-header">
        <button
          type="button"
          className="env-manager__collapse-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
          <h2 className="view-section__title env-manager__section-title">
            {t('envManager.systemVars.title')}
            <span className="env-manager__count"> ({total})</span>
          </h2>
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="env-manager__search-bar">
            <input
              type="search"
              className="input"
              placeholder={searchLabel}
              value={search}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setSearch(e.target.value)
              }
              aria-label={searchLabel}
            />
          </div>
          {filtered.length === 0 ? (
            <p className="empty-state">
              {t('envManager.systemVars.empty', {
                defaultValue: 'No system variables found.',
              })}
            </p>
          ) : (
            <ul className="env-manager__var-list">
              {filtered.map((entry) => {
                const sensitive = isSensitiveKey(entry.key);
                const revealed = reveal.isRevealed(entry.key);
                const displayValue =
                  sensitive && !revealed ? '••••••••' : entry.value;
                const revealLabel = revealed
                  ? t('envManager.hideValue', { defaultValue: 'Hide value' })
                  : t('envManager.showValue', { defaultValue: 'Show value' });
                return (
                  <li
                    key={entry.key}
                    className="env-manager__var-row env-manager__var-row--readonly"
                  >
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon env-manager__view-btn"
                      onClick={() => onOpenEntry(entry)}
                      aria-label={openLabel}
                      title={openLabel}
                    >
                      <ViewIcon />
                    </button>
                    <span className="env-manager__var-key">{entry.key}</span>
                    <span className="env-manager__var-value env-manager__var-value--system">
                      {displayValue}
                    </span>
                    {sensitive && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon env-manager__reveal-btn"
                        onClick={() => reveal.toggle(entry.key)}
                        aria-label={revealLabel}
                        title={revealLabel}
                      >
                        {revealed ? '○' : '◉'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
