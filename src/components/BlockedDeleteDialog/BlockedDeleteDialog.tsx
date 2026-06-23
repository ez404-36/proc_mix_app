import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { DeleteBlocker } from '../../utils/usageCheck';

interface BlockedDeleteDialogProps {
  /** Name of the object the user is trying to delete. */
  objectName: string;
  /** Non-empty list of blockers preventing deletion. */
  blockers: DeleteBlocker[];
  onClose: () => void;
}

/**
 * Modal shown when an object cannot be deleted because other entities depend
 * on it. Lists the blocking workflows / schedules and instructs the user to
 * remove those references first.
 *
 * Uses the same portal / backdrop / keyboard mechanics as `ConfirmDialog`.
 */
export function BlockedDeleteDialog({
  objectName,
  blockers,
  onClose,
}: BlockedDeleteDialogProps): ReactElement {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={t('deleteBlocked.title')}
      >
        <h2 className="command-form__title">{t('deleteBlocked.title')}</h2>
        <p className="command-form__message">
          {t('deleteBlocked.message', { name: objectName })}
        </p>

        <ul className="blocked-delete__list">
          {blockers.map((b) => (
            <li key={b.id} className="blocked-delete__item">
              <span className="shell-badge">
                {t(`deleteBlocked.kind.${b.kind}`)}
              </span>
              <span className="blocked-delete__name">{b.name}</span>
            </li>
          ))}
        </ul>

        <p className="blocked-delete__hint">{t('deleteBlocked.hint')}</p>

        <div className="command-form__actions">
          <button
            ref={closeRef}
            type="button"
            className="btn btn--primary"
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
