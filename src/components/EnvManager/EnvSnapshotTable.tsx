import { useMemo, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvFileStatus, EnvVarWithSources } from '../../types/envSnapshot';
import { isSensitiveKey } from '../../utils/envVars';
import { useSensitiveReveal } from '../../hooks/useSensitiveReveal';
import { GroupIcon, RerunIcon, TableViewIcon } from '../icons';

type ViewMode = 'list' | 'category';

interface EnvSnapshotTableProps {
  vars: EnvVarWithSources[];
  /**
   * Per-file scan results. The "By file" view groups by these files' `keys`
   * (every assignment textually found in the file), NOT by `vars × sources` —
   * so a variable assigned in e.g. ~/.bashrc but absent from the running
   * process environment is still listed under its file.
   */
  files: EnvFileStatus[];
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export function EnvSnapshotTable({
  vars,
  files,
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

      {viewMode === 'list' ? (
        filtered.length === 0 ? (
          <p className="empty-state">
            {search
              ? t('envManager.noResults', { defaultValue: 'No variables match the filter.' })
              : t('envManager.noVars', { defaultValue: 'No environment variables.' })}
          </p>
        ) : (
          <VarTable vars={filtered} reveal={reveal} />
        )
      ) : (
        <CategoryView vars={vars} files={files} search={search} reveal={reveal} />
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
  /**
   * The key is assigned in a scanned file but is NOT present in the current
   * process environment, so we have no runtime value to show. Renders a muted
   * placeholder instead of the value + reveal control.
   */
  notInEnv?: boolean;
}

function VarRow({
  v,
  reveal,
  hideSource = false,
  notInEnv = false,
}: VarRowProps): ReactElement {
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
        {notInEnv ? (
          <span className="env-snapshot-table__value env-snapshot-table__value--absent">
            {t('envManager.valueNotInEnv', {
              defaultValue: 'не задана в текущем окружении',
            })}
          </span>
        ) : (
          <span className="env-snapshot-table__value">{displayValue}</span>
        )}
        {!notInEnv && sensitive && (
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
  files: EnvFileStatus[];
  search: string;
  reveal: RevealHandle;
}

/**
 * A row inside a "By file" category.
 *
 * `notInEnv` is true when the key is assigned in the file but is absent from
 * the current process environment — we still list it (the file genuinely
 * assigns it) but have no runtime value to display.
 */
interface CategoryRow {
  v: EnvVarWithSources;
  notInEnv: boolean;
}

interface Category {
  /** Absolute file path, or `null` for the "source unknown" bucket. */
  file: string | null;
  rows: CategoryRow[];
}

/**
 * Group variables by source file, driven by each file's full assignment scan
 * (`EnvFileStatus.keys`) — NOT by the live process env intersected with
 * `sources`. This is what makes the per-file count here match the count shown
 * in "Scanned source files": a key assigned in ~/.bashrc appears under that
 * file even when the GUI app never sourced ~/.bashrc and so the key is absent
 * from `std::env::vars()`.
 *
 * For each file we list every key it assigns, looking up the runtime value
 * from the live env when present (flagging `notInEnv` otherwise). A final
 * "source unknown" bucket holds live env vars that no scanned file mentions.
 *
 * Category order follows the file scan order (load order); the unknown bucket
 * comes last.
 */
function buildCategories(
  vars: EnvVarWithSources[],
  files: EnvFileStatus[],
): Category[] {
  const valueByKey = new Map<string, string>();
  for (const v of vars) valueByKey.set(v.key, v.value);

  const categories: Category[] = [];

  for (const file of files) {
    if (!file.readable) continue;
    const rows: CategoryRow[] = file.keys.map((key) => {
      const value = valueByKey.get(key);
      return {
        v: { key, value: value ?? '', sources: [file.path] },
        notInEnv: value === undefined,
      };
    });
    categories.push({ file: file.path, rows });
  }

  // Keys mentioned by at least one readable scanned file — used to decide
  // which live env vars are "source unknown".
  const mentioned = new Set<string>();
  for (const file of files) {
    if (!file.readable) continue;
    for (const key of file.keys) mentioned.add(key);
  }

  const unknownRows: CategoryRow[] = vars
    .filter((v) => !mentioned.has(v.key))
    .map((v) => ({ v, notInEnv: false }));
  if (unknownRows.length > 0) {
    categories.push({ file: null, rows: unknownRows });
  }

  return categories;
}

function CategoryView({
  vars,
  files,
  search,
  reveal,
}: CategoryViewProps): ReactElement {
  const { t } = useTranslation();
  const categories = useMemo(() => {
    const built = buildCategories(vars, files);
    const q = search.trim().toLowerCase();
    if (q === '') return built;
    return built
      .map((cat) => ({
        ...cat,
        rows: cat.rows.filter(
          (r) =>
            r.v.key.toLowerCase().includes(q) ||
            r.v.value.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.rows.length > 0);
  }, [vars, files, search]);
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
      {categories.map(({ file, rows }) => {
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
                ({rows.length})
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
                  {rows.map(({ v, notInEnv }) => (
                    <VarRow
                      key={v.key}
                      v={v}
                      reveal={reveal}
                      hideSource
                      notInEnv={notInEnv}
                    />
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
