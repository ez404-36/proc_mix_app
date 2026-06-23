import { useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useSftpStore, type TransferLogEntry } from '../../stores/sftpStore';
import { HoverTooltip } from '../HoverTooltip';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CancelIcon,
  ChevronIcon,
  StatusCheckIcon,
  StatusCrossIcon,
} from '../icons';

/** Short arrow glyph describing a log entry's direction. */
function DirectionIcon({ direction }: { direction: TransferLogEntry['direction'] }): ReactElement {
  // Upload (local→remote) and download (remote→local) read most naturally as a
  // right arrow; same-pane relocations also use the right arrow. The success/
  // error status icon carries the actual outcome, so this is purely directional.
  return direction === 'download' ? <ArrowDownIcon /> : <ArrowRightIcon />;
}

/**
 * Header status bar for the SFTP manager: a compact summary button of completed
 * transfer actions that expands into a colour-coded list (green = success, red
 * = error, with the real error message). Lives in the manager header; renders
 * nothing until at least one transfer has completed.
 */
export function SftpTransferLog(): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { log, clear } = useSftpStore(
    useShallow((s) => ({ log: s.transferLog, clear: s.clearTransferLog })),
  );

  if (log.length === 0) return null;

  const errorCount = log.reduce((n, e) => (e.ok ? n : n + 1), 0);
  const okCount = log.length - errorCount;
  // Overall status drives the summary colour: any error → error, else success.
  const summaryState = errorCount > 0 ? 'error' : 'ok';

  return (
    <div className="sftp-log">
      <button
        type="button"
        className={`sftp-log__summary sftp-log__summary--${summaryState}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t('sftp.log.toggle', { defaultValue: 'Transfer history' })}
      >
        <span className="sftp-log__summary-icon">
          {errorCount > 0 ? <StatusCrossIcon /> : <StatusCheckIcon />}
        </span>
        <span className="sftp-log__summary-text">
          {errorCount > 0
            ? t('sftp.log.summaryErrors', {
                defaultValue: '{{ok}} done, {{errors}} failed',
                ok: okCount,
                errors: errorCount,
              })
            : t('sftp.log.summaryOk', { defaultValue: '{{ok}} transferred', ok: okCount })}
        </span>
        <span className={`sftp-log__chevron${open ? ' is-open' : ''}`} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div className="sftp-log__panel" role="region" aria-label={t('sftp.log.toggle', { defaultValue: 'Transfer history' })}>
          <div className="sftp-log__panel-head">
            <span>{t('sftp.log.title', { defaultValue: 'Transfers' })}</span>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={clear}
              aria-label={t('sftp.log.clear', { defaultValue: 'Clear history' })}
              title={t('sftp.log.clear', { defaultValue: 'Clear history' })}
            >
              <CancelIcon />
            </button>
          </div>
          <ul className="sftp-log__list">
            {log.map((entry) => (
              <li
                key={entry.id}
                className={`sftp-log__item sftp-log__item--${entry.ok ? 'ok' : 'error'}`}
              >
                <span className="sftp-log__item-status" aria-hidden="true">
                  {entry.ok ? <StatusCheckIcon /> : <StatusCrossIcon />}
                </span>
                <span className="sftp-log__item-dir" aria-hidden="true">
                  <DirectionIcon direction={entry.direction} />
                </span>
                <span className="sftp-log__item-name" title={entry.name}>
                  {entry.name}
                </span>
                {entry.ok ? (
                  <span className="sftp-log__item-msg">
                    {t(`sftp.log.dir.${entry.direction}`, { defaultValue: entry.direction })}
                  </span>
                ) : (
                  // The full error can be long; show it on hover via HoverTooltip
                  // (NOT the native `title`, which auto-hides on a timeout). This
                  // popover stays open until the cursor leaves / Escape.
                  <HoverTooltip
                    label={entry.error ?? t('sftp.log.failed', { defaultValue: 'Failed' })}
                    showDelayMs={0}
                  >
                    <span className="sftp-log__item-msg sftp-log__item-msg--error">
                      {entry.error ?? t('sftp.log.failed', { defaultValue: 'Failed' })}
                    </span>
                  </HoverTooltip>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
