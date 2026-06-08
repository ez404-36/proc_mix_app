import { useMemo } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../Dropdown/Dropdown";
import type { DropdownOption } from "../Dropdown/Dropdown";
import type { PageSize } from "../../types";

/** Page sizes offered by the table view. */
const PAGE_SIZES: ReadonlyArray<PageSize> = [10, 25];

export interface PaginationProps {
  /** Current 1-based page (already clamped by the caller via `paginate`). */
  page: number;
  /** Total number of pages (>= 1). */
  totalPages: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}

/**
 * Client-side pagination control for the table view: a previous/next pair
 * with a "Page X of Y" label and a page-size selector (10 / 25).
 *
 * Presentational only — the parent owns the page state and slices the data
 * with `paginate`. Navigation buttons are disabled at the range ends. The
 * size selector is always shown so the user can switch density even on a
 * single-page list; the prev/next row hides when there is only one page.
 */
export function Pagination(props: PaginationProps): ReactElement {
  const { page, totalPages, pageSize, onPageChange, onPageSizeChange } = props;
  const { t } = useTranslation();

  const sizeOptions: ReadonlyArray<DropdownOption> = useMemo(
    () =>
      PAGE_SIZES.map((size) => ({
        value: String(size),
        label: t("pagination.perPage", { count: size }),
      })),
    [t],
  );

  // Map the dropdown's string value back to a typed PageSize by lookup.
  const handleSizeChange = (value: string): void => {
    const match = PAGE_SIZES.find((size) => String(size) === value);
    if (match !== undefined) onPageSizeChange(match);
  };

  return (
    <nav className="pagination" aria-label={t("pagination.label")}>
      <div className="pagination__size">
        <span className="pagination__size-label">{t("pagination.show")}</span>
        <Dropdown
          value={String(pageSize)}
          options={sizeOptions}
          onChange={handleSizeChange}
          ariaLabel={t("pagination.perPageLabel")}
        />
      </div>

      {totalPages > 1 ? (
        <div className="pagination__nav">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label={t("pagination.previous")}
          >
            ‹
          </button>
          <span className="pagination__label">
            {t("pagination.pageLabel", { page, pages: totalPages })}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label={t("pagination.next")}
          >
            ›
          </button>
        </div>
      ) : null}
    </nav>
  );
}
