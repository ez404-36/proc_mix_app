import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { EditIcon, PlusIcon, RerunIcon, TrashIcon, ViewIcon } from '../icons';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSshHostStore, selectCheckState } from '../../stores/sshHostStore';
import type { HostCheckState } from '../../stores/sshHostStore';
import { subscribeSshConfigChanges } from '../../services/sshConnectionService';
import type {
  SshHostDraft,
  SshHostView,
  SshSource,
  SshSourceStatus,
} from '../../types/sshHost';
import { SshHostForm } from './SshHostForm';
import { SshHostViewModal } from './SshHostViewModal';

/**
 * "Connections" tab of the Environment view: a read-only inventory of SSH
 * hosts parsed from `~/.ssh/config` (and, in future, other sources). Each row
 * shows the resolved `user@host:port`, a source badge, a "managed manually"
 * badge for non-editable blocks, and the last reachability-check result.
 * "Check" probes the host; "Refresh" re-reads the inventory.
 */
/** `null` = closed, `{ host: null }` = create, `{ host }` = edit. */
type FormState = { host: SshHostView | null } | null;

/** The source ProcMix writes to (only OpenSSH is writable today). */
const WRITABLE_SOURCE: SshSource = 'open-ssh-config';

export function SshConnectionsTab(): ReactElement {
  const { t } = useTranslation();
  const hosts = useSshHostStore((s) => s.hosts);
  const patterns = useSshHostStore((s) => s.patterns);
  const sources = useSshHostStore((s) => s.sources);
  const isLoading = useSshHostStore((s) => s.isLoading);
  const loadError = useSshHostStore((s) => s.loadError);
  const load = useSshHostStore((s) => s.load);
  const save = useSshHostStore((s) => s.save);
  const remove = useSshHostStore((s) => s.remove);

  const [form, setForm] = useState<FormState>(null);
  const [pendingDelete, setPendingDelete] = useState<SshHostView | null>(null);
  const [viewing, setViewing] = useState<SshHostView | null>(null);

  useEffect(() => {
    void load();
    // Auto-refresh when ~/.ssh/config changes on disk outside ProcMix. The
    // backend watcher emits an event; we just re-load the inventory. This only
    // touches `hosts`/`sources`, never the open form or pending-delete state,
    // so a background change can't disrupt an in-progress edit.
    const unsubscribe = subscribeSshConfigChanges(() => {
      void load();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (draft: SshHostDraft): Promise<void> => {
    // Edit keeps the host's own source; create targets the writable source.
    const source = form?.host?.id.source ?? WRITABLE_SOURCE;
    await save(source, draft);
  };

  const handleConfirmDelete = (): void => {
    if (pendingDelete === null) return;
    const target = pendingDelete;
    setPendingDelete(null);
    void remove(target.id.source, target.name);
  };

  return (
    <section className="view-section">
      <div className="ssh-hosts__toolbar">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setForm({ host: null })}
        >
          <PlusIcon />
          <span>{t('envManager.ssh.newConnection', { defaultValue: 'New connection' })}</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void load()}
          disabled={isLoading}
          aria-label={t('envManager.ssh.refresh', { defaultValue: 'Refresh' })}
          title={t('envManager.ssh.refresh', { defaultValue: 'Refresh' })}
        >
          <RerunIcon />
          <span>{t('envManager.ssh.refresh', { defaultValue: 'Refresh' })}</span>
        </button>
      </div>

      {loadError !== null && (
        <p className="env-manager__root-error">
          {t('envManager.ssh.loadError', {
            defaultValue: 'Failed to load SSH connections: {{message}}',
            message: loadError,
          })}
        </p>
      )}

      {isLoading && hosts.length === 0 ? (
        <p className="empty-state">{t('common.loading')}</p>
      ) : hosts.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="ssh-hosts__list">
          {hosts.map((host) => (
            <SshHostRow
              key={`${host.id.source}:${host.id.name}`}
              host={host}
              onView={() => setViewing(host)}
              onEdit={() => setForm({ host })}
              onDelete={() => setPendingDelete(host)}
            />
          ))}
        </ul>
      )}

      <PatternsSection
        patterns={patterns}
        onView={setViewing}
        onEdit={(p) => setForm({ host: p })}
        onDelete={(p) => setPendingDelete(p)}
        onNew={() => setForm({ host: null })}
      />

      <SourceStatusFootnote sources={sources} />

      {viewing !== null && (
        <SshHostViewModal host={viewing} onClose={() => setViewing(null)} />
      )}

      {form !== null && (
        <SshHostForm
          host={form.host}
          onClose={() => setForm(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('envManager.ssh.deleteTitle', { defaultValue: 'Delete connection' })}
        message={t('envManager.ssh.deleteConfirm', {
          defaultValue: 'Remove "{{name}}" from ~/.ssh/config?',
          name: pendingDelete?.name ?? '',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------

function EmptyState(): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="empty-state">
      {t('envManager.ssh.empty', {
        defaultValue:
          'No SSH connections found. Connections are read from ~/.ssh/config.',
      })}
    </p>
  );
}

// ---------------------------------------------------------------------------

interface SshHostRowProps {
  host: SshHostView;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SshHostRow({ host, onView, onEdit, onDelete }: SshHostRowProps): ReactElement {
  const { t } = useTranslation();
  const check = useSshHostStore((s) => s.check);
  const checkState = useSshHostStore((s) =>
    selectCheckState(s, host.id.source, host.id.name),
  );

  const isChecking = checkState.kind === 'checking';

  return (
    <li className="ssh-hosts__item">
      <div className="ssh-hosts__item-main">
        <span className="ssh-hosts__name">{host.name}</span>
        <span className="ssh-hosts__target">{formatTarget(host)}</span>
      </div>

      <div className="ssh-hosts__badges">
        <SourceBadge source={host.id.source} />
        {!host.editableParams && (
          <span className="ssh-hosts__badge ssh-hosts__badge--manual">
            {t('envManager.ssh.managedManually', { defaultValue: 'managed manually' })}
          </span>
        )}
        <CheckBadge host={host} checkState={checkState} />
      </div>

      <div className="ssh-hosts__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onView}
          aria-label={t('envManager.ssh.view.action', { defaultValue: 'View' })}
          title={t('envManager.ssh.view.action', { defaultValue: 'View' })}
        >
          <ViewIcon />
        </button>

        <button
          type="button"
          className="btn btn--run"
          onClick={() => void check(host)}
          disabled={isChecking}
        >
          {isChecking
            ? t('envManager.ssh.checking', { defaultValue: 'Checking…' })
            : t('envManager.ssh.check', { defaultValue: 'Check' })}
        </button>

        {/* Edit only for blocks ProcMix can rewrite; Delete only for
            deletable blocks. */}
        {host.editableParams && (
          <button
            type="button"
            className="btn btn--view"
            onClick={onEdit}
            aria-label={t('common.edit', { defaultValue: 'Edit' })}
            title={t('common.edit', { defaultValue: 'Edit' })}
          >
            <EditIcon />
          </button>
        )}
        {host.deletable && (
          <button
            type="button"
            className="btn btn--danger"
            onClick={onDelete}
            aria-label={t('common.delete', { defaultValue: 'Delete' })}
            title={t('common.delete', { defaultValue: 'Delete' })}
          >
            <TrashIcon />
          </button>
        )}
      </div>
    </li>
  );
}

/** `user@host:port`, omitting parts the config didn't declare. */
function formatTarget(host: SshHostView): string {
  const hostName = host.hostName ?? host.name;
  const userPart = host.user !== null ? `${host.user}@` : '';
  const portPart = host.port !== null ? `:${host.port}` : '';
  return `${userPart}${hostName}${portPart}`;
}

// ---------------------------------------------------------------------------

interface PatternsSectionProps {
  patterns: SshHostView[];
  onView: (pattern: SshHostView) => void;
  onEdit: (pattern: SshHostView) => void;
  onDelete: (pattern: SshHostView) => void;
  onNew: () => void;
}

/**
 * Collapsible "Rules & templates" section listing wildcard/pattern blocks
 * (`Host *`, `*.example.com`, …). These are matching rules applied to groups
 * of hosts. They support View always, and Edit/Delete when ProcMix can write
 * the block (user-config, only modelled directives) — editing a pattern's
 * parameters is safe; the form warns when its name changes (it reassigns the
 * rule's scope). A "+ New rule" button creates a pattern block. Hidden only
 * when there are no patterns AND nothing can be created — but since creation
 * is always possible, the header is shown so the button is reachable.
 */
function PatternsSection({
  patterns,
  onView,
  onEdit,
  onDelete,
  onNew,
}: PatternsSectionProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="env-manager__sources ssh-hosts__patterns">
      <div className="ssh-hosts__patterns-header">
        <button
          type="button"
          className="env-manager__sources-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▼' : '▶'}</span>
          {t('envManager.ssh.patternsTitle', {
            defaultValue: 'Rules & templates ({{count}})',
            count: patterns.length,
          })}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onNew}>
          <PlusIcon />
          <span>{t('envManager.ssh.newRule', { defaultValue: 'New rule' })}</span>
        </button>
      </div>
      {open && (
        <>
          <p className="form-hint">
            {t('envManager.ssh.patternsHint', {
              defaultValue:
                'Pattern blocks apply to groups of hosts. They are not connections; editing one changes the settings for the whole group.',
            })}
          </p>
          {patterns.length > 0 && (
            <ul className="ssh-hosts__list">
              {patterns.map((pattern) => (
                <li
                  key={`${pattern.id.source}:${pattern.id.name}`}
                  className="ssh-hosts__item ssh-hosts__item--pattern"
                >
                  <div className="ssh-hosts__item-main">
                    <span className="ssh-hosts__name">{pattern.name}</span>
                    <span className="ssh-hosts__target">{formatPatternParams(pattern)}</span>
                  </div>
                  <div className="ssh-hosts__badges">
                    <SourceBadge source={pattern.id.source} />
                    {!pattern.editableParams && (
                      <span className="ssh-hosts__badge ssh-hosts__badge--manual">
                        {t('envManager.ssh.managedManually', { defaultValue: 'managed manually' })}
                      </span>
                    )}
                  </div>
                  <div className="ssh-hosts__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => onView(pattern)}
                      aria-label={t('envManager.ssh.view.action', { defaultValue: 'View' })}
                      title={t('envManager.ssh.view.action', { defaultValue: 'View' })}
                    >
                      <ViewIcon />
                    </button>
                    {pattern.editableParams && (
                      <button
                        type="button"
                        className="btn btn--view"
                        onClick={() => onEdit(pattern)}
                        aria-label={t('common.edit', { defaultValue: 'Edit' })}
                        title={t('common.edit', { defaultValue: 'Edit' })}
                      >
                        <EditIcon />
                      </button>
                    )}
                    {pattern.deletable && (
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => onDelete(pattern)}
                        aria-label={t('common.delete', { defaultValue: 'Delete' })}
                        title={t('common.delete', { defaultValue: 'Delete' })}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Summarise the modelled params a pattern sets (e.g. "ci@ :22"), or its
 *  HostName when present. Patterns rarely set HostName, so we show the
 *  declared User/Port instead of a connect target. */
function formatPatternParams(pattern: SshHostView): string {
  const parts: string[] = [];
  if (pattern.user !== null) parts.push(`User ${pattern.user}`);
  if (pattern.port !== null) parts.push(`Port ${pattern.port}`);
  if (pattern.identityFile !== null) parts.push(`IdentityFile ${pattern.identityFile}`);
  if (pattern.hostName !== null) parts.push(`HostName ${pattern.hostName}`);
  return parts.join('  ');
}

// ---------------------------------------------------------------------------

interface CheckBadgeProps {
  host: SshHostView;
  checkState: HostCheckState;
}

/**
 * The reachability badge. While a probe runs it shows nothing (the button
 * shows "Checking…"); otherwise it reflects the freshest known result —
 * either the in-session check or the stored `lastCheckOk`.
 */
function CheckBadge({ host, checkState }: CheckBadgeProps): ReactElement | null {
  const { t } = useTranslation();

  if (checkState.kind === 'checking') return null;

  const reachable =
    checkState.kind === 'done' ? checkState.result.reachable : host.lastCheckOk;

  if (reachable === null || reachable === undefined) {
    return (
      <span className="ssh-hosts__badge ssh-hosts__badge--unknown">
        {t('envManager.ssh.notChecked', { defaultValue: 'not checked' })}
      </span>
    );
  }

  const message =
    checkState.kind === 'done' ? checkState.result.message : undefined;

  return reachable ? (
    <span className="ssh-hosts__badge ssh-hosts__badge--ok" title={message}>
      {t('envManager.ssh.reachable', { defaultValue: 'reachable' })}
    </span>
  ) : (
    <span className="ssh-hosts__badge ssh-hosts__badge--fail" title={message}>
      {t('envManager.ssh.unreachable', { defaultValue: 'unreachable' })}
    </span>
  );
}

// ---------------------------------------------------------------------------

interface SourceBadgeProps {
  source: SshSource;
}

function SourceBadge({ source }: SourceBadgeProps): ReactElement {
  const { t } = useTranslation();
  return (
    <span className="ssh-hosts__badge ssh-hosts__badge--source">
      {t(`envManager.ssh.source.${source}`, { defaultValue: sourceLabel(source) })}
    </span>
  );
}

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

// ---------------------------------------------------------------------------

interface SourceStatusFootnoteProps {
  sources: SshSourceStatus[];
}

/**
 * Explains sources that exist but contributed no hosts (a read error), so the
 * user understands an empty/short list. Available-but-empty and not-yet-
 * implemented sources are intentionally silent here to avoid noise.
 */
function SourceStatusFootnote({ sources }: SourceStatusFootnoteProps): ReactElement | null {
  const { t } = useTranslation();
  const errored = sources.filter((s) => s.error !== null);
  if (errored.length === 0) return null;

  return (
    <ul className="ssh-hosts__source-status">
      {errored.map((s) => (
        <li key={s.source} className="env-manager__root-error">
          {t('envManager.ssh.sourceError', {
            defaultValue: '{{source}}: {{message}}',
            source: sourceLabel(s.source),
            message: s.error,
          })}
        </li>
      ))}
    </ul>
  );
}
