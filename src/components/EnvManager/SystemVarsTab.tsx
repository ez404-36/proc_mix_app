import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useEnvManagerStore } from '../../stores/envManagerStore';
import { setAdminPassword } from '../../utils/adminPassword';
import { promptForAdminPassword } from '../../utils/adminPasswordPrompt';
import type { EnvSnapshot } from '../../types/envSnapshot';
import { EnvSnapshotTable } from './EnvSnapshotTable';

type Scope = 'user' | 'root';

/**
 * "System variables" tab of the Environment view: the read-only env snapshot
 * with a user/root sub-switch. This is the original EnvManager body, extracted
 * unchanged so the new top-level tab shell (`EnvManager`) can sit "Connections"
 * alongside it. The user/root sub-tabs keep their existing `env-manager__tab*`
 * classes; the top-level tabs use a distinct `env-manager__section-tab*` family.
 */
export function SystemVarsTab(): ReactElement {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('user');

  const userSnapshot = useEnvManagerStore((s) => s.userSnapshot);
  const isUserLoading = useEnvManagerStore((s) => s.isUserLoading);
  const rootState = useEnvManagerStore((s) => s.rootState);
  const loadUser = useEnvManagerStore((s) => s.loadUser);
  const loadRoot = useEnvManagerStore((s) => s.loadRoot);

  useEffect(() => {
    void loadUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scope === 'root' && rootState.kind === 'idle') {
      void loadRoot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const handleEnterPassword = async (): Promise<void> => {
    const result = await promptForAdminPassword();
    if (result === null) return;
    try {
      if (result.remember) {
        await setAdminPassword(result.password);
      }
    } catch {
      // non-fatal
    }
    void loadRoot();
  };

  return (
    <>
      <div className="env-manager__tabs">
        <button
          type="button"
          className={`env-manager__tab${scope === 'user' ? ' is-active' : ''}`}
          onClick={() => setScope('user')}
        >
          {t('envManager.tabUser', { defaultValue: 'Пользователь' })}
          {userSnapshot !== null && (
            <span className="env-manager__tab-count">
              {' '}({userSnapshot.vars.length})
            </span>
          )}
        </button>
        <button
          type="button"
          className={`env-manager__tab${scope === 'root' ? ' is-active' : ''}`}
          onClick={() => setScope('root')}
        >
          {t('envManager.tabRoot', { defaultValue: 'Root' })}
          {rootState.kind === 'loaded' && (
            <span className="env-manager__tab-count">
              {' '}({rootState.snapshot.vars.length})
            </span>
          )}
        </button>
      </div>

      {scope === 'user' && (
        <section className="view-section">
          {isUserLoading ? (
            <p className="empty-state">{t('common.loading')}</p>
          ) : userSnapshot === null ? (
            <p className="empty-state">
              {t('envManager.userLoadFailed', {
                defaultValue: 'Failed to load environment variables.',
              })}
            </p>
          ) : (
            <SnapshotView
              snapshot={userSnapshot}
              onRefresh={() => void loadUser()}
              isRefreshing={isUserLoading}
            />
          )}
        </section>
      )}

      {scope === 'root' && (
        <section className="view-section">
          <RootScopePanel
            rootState={rootState}
            onEnterPassword={() => void handleEnterPassword()}
            onRefresh={() => void loadRoot()}
          />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SnapshotView — table + scanned files list
// ---------------------------------------------------------------------------

interface SnapshotViewProps {
  snapshot: EnvSnapshot;
  onRefresh: () => void;
  isRefreshing: boolean;
}

/**
 * Full snapshot display: the variable table with toolbar (search + refresh)
 * and, below it, the collapsible list of scanned source files.
 *
 * П.3: the files list is hidden when no files were readable — there's nothing
 * meaningful to show (all entries would be "does not exist").
 *
 * П.4: only readable files are listed, so /etc/environment appears when
 * it exists and was successfully read.
 */
function SnapshotView({
  snapshot,
  onRefresh,
  isRefreshing,
}: SnapshotViewProps): ReactElement {
  const { t } = useTranslation();
  const readableFiles = snapshot.files.filter((f) => f.readable);

  // Open by default so the user sees the list without having to discover it.
  const [filesOpen, setFilesOpen] = useState(true);

  return (
    <>
      <EnvSnapshotTable
        vars={snapshot.vars}
        files={snapshot.files}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
      />

      {/* П.3: only show scanned files section when there are readable files */}
      {readableFiles.length > 0 && (
        <div className="env-manager__sources">
          <button
            type="button"
            className="env-manager__sources-toggle"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen((o) => !o)}
          >
            <span aria-hidden="true">{filesOpen ? '▼' : '▶'}</span>
            {t('envManager.sourcesTitle', {
              defaultValue: 'Scanned source files ({{count}})',
              count: readableFiles.length,
            })}
          </button>
          {filesOpen && (
            <ul className="env-manager__sources-list">
              {readableFiles.map((f) => (
                <li key={f.path} className="env-manager__sources-item">
                  <span className="env-manager__sources-path">{f.path}</span>
                  <span className="env-manager__sources-keys">
                    {f.keys.length === 0
                      ? t('envManager.sourcesNoKeys', { defaultValue: 'no assignments found' })
                      : t('envManager.sourcesKeyCount', {
                          defaultValue: '{{count}} variables',
                          count: f.keys.length,
                        })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// RootScopePanel
// ---------------------------------------------------------------------------

interface RootScopePanelProps {
  rootState: ReturnType<typeof useEnvManagerStore.getState>['rootState'];
  onEnterPassword: () => void;
  onRefresh: () => void;
}

function RootScopePanel({
  rootState,
  onEnterPassword,
  onRefresh,
}: RootScopePanelProps): ReactElement {
  const { t } = useTranslation();
  const isRefreshing = rootState.kind === 'loading';

  if (rootState.kind === 'idle' || rootState.kind === 'loading') {
    return <p className="empty-state">{t('common.loading')}</p>;
  }

  if (rootState.kind === 'no_password') {
    return (
      <div className="env-manager__root-gate">
        <p className="env-manager__root-gate-hint">
          {t('envManager.rootNoPassword', {
            defaultValue:
              'To view the root environment, an administrator password is required.',
          })}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onEnterPassword}
        >
          {t('envManager.rootEnterPassword', {
            defaultValue: 'Enter admin password…',
          })}
        </button>
      </div>
    );
  }

  if (rootState.kind === 'error') {
    return (
      <div className="env-manager__root-gate">
        <p className="env-manager__root-error">
          {t('envManager.rootError', {
            defaultValue: 'Error loading root environment: {{message}}',
            message: rootState.message,
          })}
        </p>
        <button type="button" className="btn btn--ghost" onClick={onRefresh}>
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  return (
    <SnapshotView
      snapshot={rootState.snapshot}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
    />
  );
}
