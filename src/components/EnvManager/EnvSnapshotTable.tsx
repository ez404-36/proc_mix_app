import { useMemo, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvVarWithSources } from '../../types/envSnapshot';
import { isSensitiveKey } from '../../utils/envVars';
import { useSensitiveReveal } from '../../hooks/useSensitiveReveal';
import { GroupIcon, RerunIcon, TableViewIcon } from '../icons';

type ViewMode = 'list' | 'category';

interface EnvSnapshotTableProps {
  vars: EnvVarWithSources[];
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export function EnvSnapshotTable({
  vars,
  onRefresh,
  isRefreshing = false,
}: EnvSnapshotTableProps): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const reveal = useSensitiveReveal();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === '') return vars;
    return vars.filter(
      (v) =>
        v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q),
    );
  }, [vars, search]);

  const refreshLabel = t('envManager.refresh', { defaultValue: 'Обновить' });

  return (
    <div className="env-snapshot-table">
      <div className="env-snapshot-table__toolbar">
        <input
          type="search"
          className="input env-snapshot-table__search-input"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          placeholder={t('envManager.searchPlaceholder', {
            defaultValue: 'Filter by name or value…',
          })}
          aria-label={t('envManager.searchPlaceholder', {
            defaultValue: 'Filter by name or value…',
          })}
        />

        {/* View mode toggle — icon-only segmented control, same pattern as
            Library / Scheduler ListControls */}
        <div
          className="list-controls__modes"
          role="group"
          aria-label={t('envManager.viewModeLabel', { defaultValue: 'View mode' })}
        >
          <button
            type="button"
            className={`btn btn--ghost btn--icon${viewMode === 'list' ? ' is-active' : ''}`}
            onClick={() => setViewMode('list')}
            aria-pressed={viewMode === 'list'}
            aria-label={t('envManager.viewList', { defaultValue: 'List' })}
            title={t('envManager.viewList', { defaultValue: 'Список' })}
          >
            <TableViewIcon />
          </button>
          <button
            type="button"
            className={`btn btn--ghost btn--icon${viewMode === 'category' ? ' is-active' : ''}`}
            onClick={() => setViewMode('category')}
            aria-pressed={viewMode === 'category'}
            aria-label={t('envManager.viewCategory', { defaultValue: 'By file' })}
            title={t('envManager.viewCategory', { defaultValue: 'По файлам' })}
          >
            <GroupIcon />
          </button>
        </div>

        <button
          type="button"
          className="btn btn--ghost env-snapshot-table__refresh"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={refreshLabel}
          title={refreshLabel}
        >
          <RerunIcon />
          <span>{refreshLabel}</span>
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="empty-state">
          {search
            ? t('envManager.noResults', { defaultValue: 'No variables match the filter.' })
            : t('envManager.noVars', { defaultValue: 'No environment variables.' })}
        </p>
      ) : viewMode === 'list' ? (
        <VarTable vars={filtered} reveal={reveal} />
      ) : (
        <CategoryView vars={filtered} reveal={reveal} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared row renderer
// ---------------------------------------------------------------------------

interface RevealHandle {
  isRevealed: (key: string) => boolean;
  toggle: (key: string) => void;
}

interface VarRowProps {
  v: EnvVarWithSources;
  reveal: RevealHandle;
  /** When true, hide the Source column (used inside category sections). */
  hideSource?: boolean;
}

function VarRow({ v, reveal, hideSource = false }: VarRowProps): ReactElement {
  const { t } = useTranslation();
  const sensitive = isSensitiveKey(v.key);
  const revealed = reveal.isRevealed(v.key);
  const displayValue = sensitive && !revealed ? '••••••••' : v.value;
  return (
    <tr className="env-snapshot-table__row">
      <td className="env-snapshot-table__td env-snapshot-table__td--key">
        {v.key}
      </td>
      <td className="env-snapshot-table__td env-snapshot-table__td--value">
        <span className="env-snapshot-table__value">{displayValue}</span>
        {sensitive && (
          <button
            type="button"
            className="btn btn--ghost btn--icon env-snapshot-table__reveal"
            onClick={() => reveal.toggle(v.key)}
            aria-label={
              revealed
                ? t('envManager.hideValue', { defaultValue: 'Hide value' })
                : t('envManager.showValue', { defaultValue: 'Show value' })
            }
            title={
              revealed
                ? t('envManager.hideValue', { defaultValue: 'Hide value' })
                : t('envManager.showValue', { defaultValue: 'Show value' })
            }
          >
            {revealed ? '○' : '◉'}
          </button>
        )}
      </td>
      {!hideSource && (
        <td className="env-snapshot-table__td env-snapshot-table__td--source">
          <SourceCell sources={v.sources} />
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

interface VarTableProps {
  vars: EnvVarWithSources[];
  reveal: RevealHandle;
}

function VarTable({ vars, reveal }: VarTableProps): ReactElement {
  const { t } = useTranslation();
  return (
    <table className="env-snapshot-table__table">
      <thead>
        <tr>
          <th className="env-snapshot-table__th env-snapshot-table__th--key">
            {t('envManager.colKey', { defaultValue: 'Variable' })}
          </th>
          <th className="env-snapshot-table__th env-snapshot-table__th--value">
            {t('envManager.colValue', { defaultValue: 'Value' })}
          </th>
          <th className="env-snapshot-table__th env-snapshot-table__th--source">
            {t('envManager.colSource', { defaultValue: 'Source' })}
          </th>
        </tr>
      </thead>
      <tbody>
        {vars.map((v) => (
          <VarRow key={v.key} v={v} reveal={reveal} />
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Category view
// ---------------------------------------------------------------------------

interface CategoryViewProps {
  vars: EnvVarWithSources[];
  reveal: RevealHandle;
}

/**
 * Group variables by source file.
 *
 * A variable with N sources appears in N categories (one per file).
 * Variables with no known source go into a special "unknown" category.
 * The order of categories follows the first appearance of each file path
 * across all variables (preserves natural load order).
 */
function buildCategories(
  vars: EnvVarWithSources[],
): Array<{ file: string | null; vars: EnvVarWithSources[] }> {
  const order: (string | null)[] = [];
  const map = new Map<string | null, EnvVarWithSources[]>();

  for (const v of vars) {
    if (v.sources.length === 0) {
      if (!map.has(null)) {
        order.push(null);
        map.set(null, []);
      }
      map.get(null)!.push(v);
    } else {
      for (const src of v.sources) {
        if (!map.has(src)) {
          order.push(src);
          map.set(src, []);
        }
        map.get(src)!.push(v);
      }
    }
  }

  return order.map((file) => ({ file, vars: map.get(file)! }));
}

function CategoryView({ vars, reveal }: CategoryViewProps): ReactElement {
  const { t } = useTranslation();
  const categories = useMemo(() => buildCategories(vars), [vars]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const unknownLabel = t('envManager.categoryUnknown', {
    defaultValue: 'Источник не определён',
  });

  return (
    <div className="env-snapshot-categories">
      {categories.map(({ file, vars: catVars }) => {
        const key = file ?? '__unknown__';
        const label = file ?? unknownLabel;
        const isCollapsed = collapsed.has(key);
        return (
          <div key={key} className="env-snapshot-category">
            <button
              type="button"
              className="env-snapshot-category__header"
              aria-expanded={!isCollapsed}
              onClick={() => toggle(key)}
            >
              <span
                className="env-snapshot-category__arrow"
                aria-hidden="true"
              >
                {isCollapsed ? '▶' : '▼'}
              </span>
              <span
                className={`env-snapshot-category__title${file === null ? ' env-snapshot-category__title--unknown' : ''}`}
                title={file ?? undefined}
              >
                {label}
              </span>
              <span className="env-snapshot-category__count">
                ({catVars.length})
              </span>
            </button>

            {!isCollapsed && (
              <table className="env-snapshot-table__table env-snapshot-category__table">
                <thead>
                  <tr>
                    <th className="env-snapshot-table__th env-snapshot-table__th--key">
                      {t('envManager.colKey', { defaultValue: 'Variable' })}
                    </th>
                    <th className="env-snapshot-table__th env-snapshot-table__th--value env-snapshot-category__value-col">
                      {t('envManager.colValue', { defaultValue: 'Value' })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catVars.map((v) => (
                    <VarRow key={v.key} v={v} reveal={reveal} hideSource />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source cell (list view only)
// ---------------------------------------------------------------------------

interface SourceCellProps {
  sources: string[];
}

function SourceCell({ sources }: SourceCellProps): ReactElement {
  const { t } = useTranslation();

  if (sources.length === 0) {
    return (
      <span className="env-snapshot-table__source env-snapshot-table__source--unknown">
        {t('envManager.sourceUnknown', { defaultValue: 'не удалось определить источник' })}
      </span>
    );
  }

  if (sources.length === 1) {
    return (
      <span className="env-snapshot-table__source">
        {sources[0]}
      </span>
    );
  }

  return (
    <span className="env-snapshot-table__source-chain">
      {sources.map((src, i) => (
        <span key={src} className="env-snapshot-table__source-chain-item">
          <span className="env-snapshot-table__source">{src}</span>
          {i < sources.length - 1 && (
            <span
              className="env-snapshot-table__source-chain-arrow"
              aria-hidden="true"
            >
              ↓
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
