import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import type { SshHostDraft, SshHostView } from '../../types/sshHost';
import { getCachedPlatform } from '../../utils/platform';
import {
  clearSshPassword,
  hasSshPassword,
  setSshPassword,
} from '../../services/sshConnectionService';

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

  // ---- Saved SSH password (Unix only) ------------------------------------
  // Password auth is Unix-only (the askpass transport is unreliable on
  // Win32-OpenSSH), so the control is hidden on Windows. A saved password is
  // keyed by the host's PERSISTED alias (`host.name`) — so it is only offered
  // when EDITING a concrete (non-pattern) host, not while creating one or for a
  // wildcard rule. Once saved it is used by BOTH `ssh` remote runs and SFTP.
  // The value never crosses back to the frontend; we only learn whether one
  // exists and can set/clear it.
  const isWindows = getCachedPlatform() === 'windows';
  const passwordAlias = isEdit && host !== null ? host.name : '';
  const canManagePassword =
    !isWindows && passwordAlias !== '' && !isPattern(passwordAlias);

  const [passwordStored, setPasswordStored] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  // Refresh the "is a password saved?" indicator for the host being edited. A
  // read failure (keychain unavailable) is treated as "not saved" rather than
  // surfaced — the user can still attempt to set one, which reports the real
  // error. Guard against a late resolve after the modal closed.
  useEffect(() => {
    if (!canManagePassword) {
      setPasswordStored(false);
      return;
    }
    let active = true;
    void hasSshPassword(passwordAlias)
      .then((stored) => {
        if (active) setPasswordStored(stored);
      })
      .catch(() => {
        if (active) setPasswordStored(false);
      });
    return () => {
      active = false;
    };
  }, [canManagePassword, passwordAlias]);

  const handleSavePassword = useCallback(async (): Promise<void> => {
    if (passwordInput === '' || passwordAlias === '') return;
    setPasswordBusy(true);
    try {
      await setSshPassword(passwordAlias, passwordInput);
      setPasswordStored(true);
      setEditingPassword(false);
      setPasswordInput('');
      Message.success(
        t('envManager.ssh.form.sshPasswordSaved', {
          defaultValue: 'SSH password saved',
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t('envManager.ssh.form.sshPasswordSaveError', {
          defaultValue: 'Failed to save SSH password',
        })}: ${msg}`,
      );
    } finally {
      setPasswordBusy(false);
    }
  }, [passwordAlias, passwordInput, t]);

  const handleClearPassword = useCallback(async (): Promise<void> => {
    if (passwordAlias === '') return;
    setPasswordBusy(true);
    try {
      await clearSshPassword(passwordAlias);
      setPasswordStored(false);
      Message.success(
        t('envManager.ssh.form.sshPasswordCleared', {
          defaultValue: 'SSH password cleared',
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t('envManager.ssh.form.sshPasswordClearError', {
          defaultValue: 'Failed to clear SSH password',
        })}: ${msg}`,
      );
    } finally {
      setPasswordBusy(false);
    }
  }, [passwordAlias, t]);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !saving) onClose();
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
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
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

        {/* Saved SSH password (Unix only). Keyed by the persisted alias, so it
            is offered only when editing a concrete host. Once saved it is used
            by both `ssh` remote runs and SFTP file transfers. The value is held
            in the OS keychain by the backend and never read back here. */}
        {canManagePassword && (
          <div className="form-field ssh-host-form__password">
            <label className="form-field__label" htmlFor="ssh-form-password">
              {t('envManager.ssh.form.sshPasswordLabel', {
                defaultValue: 'Saved password',
              })}
            </label>

            {editingPassword ? (
              <div className="ssh-host-form__password-row">
                <input
                  id="ssh-form-password"
                  type="password"
                  className="input"
                  autoComplete="off"
                  aria-label={t('envManager.ssh.form.sshPasswordInputLabel', {
                    defaultValue: 'SSH password for {{alias}}',
                    alias: passwordAlias,
                  })}
                  value={passwordInput}
                  disabled={passwordBusy}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSavePassword();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingPassword(false);
                      setPasswordInput('');
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={passwordBusy || passwordInput === ''}
                  onClick={() => void handleSavePassword()}
                >
                  {t('envManager.ssh.form.sshPasswordSave', { defaultValue: 'Save' })}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={passwordBusy}
                  onClick={() => {
                    setEditingPassword(false);
                    setPasswordInput('');
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div className="ssh-host-form__password-row">
                <span className="form-hint" role="note">
                  {passwordStored
                    ? t('envManager.ssh.form.sshPasswordStatusSaved', {
                        defaultValue: 'Saved ✓',
                      })
                    : t('envManager.ssh.form.sshPasswordStatusNone', {
                        defaultValue: 'Not saved — keys/agent will be used.',
                      })}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={passwordBusy}
                  onClick={() => {
                    setPasswordInput('');
                    setEditingPassword(true);
                  }}
                >
                  {passwordStored
                    ? t('envManager.ssh.form.sshPasswordChange', { defaultValue: 'Change…' })
                    : t('envManager.ssh.form.sshPasswordSet', { defaultValue: 'Set password…' })}
                </button>
                {passwordStored && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={passwordBusy}
                    onClick={() => void handleClearPassword()}
                  >
                    {t('envManager.ssh.form.sshPasswordClear', { defaultValue: 'Clear' })}
                  </button>
                )}
              </div>
            )}

            <p className="form-hint">
              {t('envManager.ssh.form.sshPasswordHint', {
                defaultValue:
                  'Stored in your OS keychain for this host so connections (run & file transfer) can authenticate without a prompt. SSH keys are preferred; the password is a fallback. (Unix only.)',
              })}
            </p>
          </div>
        )}

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
