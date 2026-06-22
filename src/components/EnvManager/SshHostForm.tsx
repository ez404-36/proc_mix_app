import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SshHostDraft, SshHostView } from '../../types/sshHost';

interface SshHostFormProps {
  /** The host being edited, or `null` for a create. */
  host: SshHostView | null;
  onClose: () => void;
  /** Persist the draft. Rejects with a message shown inline on failure. */
  onSave: (draft: SshHostDraft) => Promise<void>;
}

/**
 * Client-side `Host` name check mirroring the backend `is_safe_host_pattern`.
 * Allows wildcard pattern characters (`*`, `?`, `!`) so the same form can
 * create/edit pattern blocks like `*.staging.example.com`; still rejects a
 * leading `-` and anything that could corrupt the file.
 */
function isValidHostName(name: string): boolean {
  if (name.length === 0 || name.startsWith('-')) return false;
  return /^[A-Za-z0-9._:@*?!-]+$/.test(name);
}

/** Whether a `Host` name is a wildcard/pattern (vs a concrete alias). */
function isPattern(name: string): boolean {
  return name.includes('*') || name.includes('?') || name.startsWith('!');
}

/**
 * Create/edit modal for an editable SSH host. Mirrors the app modal chrome
 * (`command-form__backdrop` + `command-form`, Esc/backdrop close, portal to
 * body). Only the modelled fields are exposed; validation runs client-side
 * before the IPC and the backend re-validates authoritatively. A backend
 * error (read-only, IO, …) is surfaced inline rather than as a toast.
 */
export function SshHostForm({ host, onClose, onSave }: SshHostFormProps): ReactElement {
  const { t } = useTranslation();
  const isEdit = host !== null;

  const [name, setName] = useState(host?.name ?? '');
  const [hostName, setHostName] = useState(host?.hostName ?? '');
  const [user, setUser] = useState(host?.user ?? '');
  const [port, setPort] = useState(host?.port != null ? String(host.port) : '');
  const [identityFile, setIdentityFile] = useState(host?.identityFile ?? '');

  const [nameError, setNameError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 0);
  }, []);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !saving) onClose();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !saving) {
      e.preventDefault();
      onClose();
    }
  };

  const validate = (): boolean => {
    let ok = true;
    if (!isValidHostName(name.trim())) {
      setNameError(
        t('envManager.ssh.form.aliasInvalid', {
          defaultValue: 'Use letters, digits and . _ - : @ * ? (no leading dash).',
        }),
      );
      ok = false;
    } else {
      setNameError(null);
    }

    if (port.trim() !== '') {
      const n = Number(port.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        setPortError(
          t('envManager.ssh.form.portInvalid', { defaultValue: 'Port must be 1-65535.' }),
        );
        ok = false;
      } else {
        setPortError(null);
      }
    } else {
      setPortError(null);
    }
    return ok;
  };

  const handleSubmit = async (): Promise<void> => {
    setSubmitError(null);
    if (!validate()) return;

    const trimmedName = name.trim();
    const draft: SshHostDraft = {
      name: trimmedName,
      // On a rename, tell the backend which old block to remove.
      previousName: isEdit && host.name !== trimmedName ? host.name : null,
      hostName: hostName.trim() === '' ? null : hostName.trim(),
      user: user.trim() === '' ? null : user.trim(),
      port: port.trim() === '' ? null : Number(port.trim()),
      identityFile: identityFile.trim() === '' ? null : identityFile.trim(),
    };

    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit
    ? t('envManager.ssh.form.editTitle', { defaultValue: 'Edit connection' })
    : t('envManager.ssh.form.createTitle', { defaultValue: 'New connection' });

  // Warn (non-blocking) when editing a PATTERN's name: a rename reassigns the
  // rule's scope to a different group of hosts. Shown for patterns only.
  const showRenameWarning =
    isEdit &&
    name.trim() !== host.name &&
    (isPattern(host.name) || isPattern(name.trim()));

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--meta"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="command-form__title">{title}</h2>

        {/* Field labels are the literal ssh_config directive names, with
            their exact casing — they are not translated, so the form maps
            one-to-one onto what gets written to ~/.ssh/config. */}
        <div className="form-field">
          <label className="form-field__label form-field__label--literal" htmlFor="ssh-form-name">
            Host
          </label>
          <input
            id="ssh-form-name"
            ref={nameRef}
            type="text"
            className={`input${nameError !== null ? ' input--error' : ''}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            aria-invalid={nameError !== null}
          />
          {nameError !== null && <p className="form-hint env-manager__root-error">{nameError}</p>}
          {nameError === null && showRenameWarning && (
            <p className="form-hint ssh-host-form__warning">
              {t('envManager.ssh.form.renameWarning', {
                defaultValue:
                  'Changing a pattern name reassigns these settings to a different group of hosts.',
              })}
            </p>
          )}
        </div>

        <div className="form-field">
          <label className="form-field__label form-field__label--literal" htmlFor="ssh-form-hostname">
            HostName
          </label>
          <input
            id="ssh-form-hostname"
            type="text"
            className="input"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            disabled={saving}
            placeholder={t('envManager.ssh.form.hostNamePlaceholder', {
              defaultValue: 'e.g. 203.0.113.10 or host.example.com',
            })}
          />
        </div>

        <div className="form-field">
          <label className="form-field__label form-field__label--literal" htmlFor="ssh-form-user">
            User
          </label>
          <input
            id="ssh-form-user"
            type="text"
            className="input"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="form-field">
          <label className="form-field__label form-field__label--literal" htmlFor="ssh-form-port">
            Port
          </label>
          <input
            id="ssh-form-port"
            type="text"
            inputMode="numeric"
            className={`input${portError !== null ? ' input--error' : ''}`}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={saving}
            aria-invalid={portError !== null}
            placeholder="22"
          />
          {portError !== null && <p className="form-hint env-manager__root-error">{portError}</p>}
        </div>

        <div className="form-field">
          <label className="form-field__label form-field__label--literal" htmlFor="ssh-form-identity">
            IdentityFile
          </label>
          <input
            id="ssh-form-identity"
            type="text"
            className="input"
            value={identityFile}
            onChange={(e) => setIdentityFile(e.target.value)}
            disabled={saving}
            placeholder="~/.ssh/id_ed25519"
          />
        </div>

        {submitError !== null && (
          <p className="env-manager__root-error">{submitError}</p>
        )}

        <div className="command-form__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
