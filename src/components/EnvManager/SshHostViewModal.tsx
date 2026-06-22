import { useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SshHostView, SshSource } from '../../types/sshHost';

interface SshHostViewModalProps {
  host: SshHostView;
  onClose: () => void;
}

/** Human label for a source (kept in sync with SshConnectionsTab's badge). */
function sourceLabel(source: SshSource): string {
  switch (source) {
    case 'open-ssh-config':
      return 'OpenSSH';
    case 'putty':
      return 'PuTTY';
    case 'wsl':
      return 'WSL';
    case 'system-config':
      return 'System';
  }
}

/**
 * Read-only "view" modal for an SSH host or pattern. Shows the parsed,
 * modelled fields at a glance, then the FULL block text exactly as it appears
 * in the source file — so directives ProcMix doesn't model (`ProxyJump`,
 * `SendEnv`, …) are visible here, which is the only place they surface.
 *
 * Pure presentation: no editing. Mirrors the app modal chrome
 * (`command-form__backdrop` + `command-form--view`, portal to body, Esc /
 * backdrop close) used by the other view dialogs.
 */
export function SshHostViewModal({ host, onClose }: SshHostViewModalProps): ReactElement {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setTimeout(() => closeRef.current?.focus(), 0);
  }, []);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const rows: Array<[string, string | null]> = [
    [t('envManager.ssh.view.source', { defaultValue: 'Source' }), sourceLabel(host.id.source)],
    ['HostName', host.hostName],
    ['User', host.user],
    ['Port', host.port !== null ? String(host.port) : null],
    ['IdentityFile', host.identityFile],
  ];

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--view ssh-host-view"
        role="dialog"
        aria-modal="true"
        aria-label={host.name}
      >
        <h2 className="command-form__title">{host.name}</h2>

        <div className="ssh-host-view__body">
          <dl className="ssh-host-view__fields">
            {rows.map(([label, value]) => (
              <div key={label} className="ssh-host-view__row">
                <dt className="ssh-host-view__label">{label}</dt>
                <dd className="ssh-host-view__value">
                  {value ?? (
                    <span className="ssh-host-view__value--unset">
                      {t('envManager.ssh.view.notSet', { defaultValue: '—' })}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {host.rawText.trim() !== '' && (
            <div className="ssh-host-view__raw">
              <div className="ssh-host-view__raw-title">
                {t('envManager.ssh.view.rawTitle', { defaultValue: 'Full block (as in file)' })}
              </div>
              <pre className="ssh-host-view__raw-pre">{host.rawText}</pre>
            </div>
          )}
        </div>

        <div className="command-form__actions">
          <button ref={closeRef} type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
