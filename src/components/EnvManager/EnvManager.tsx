import { useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SystemVarsTab } from './SystemVarsTab';
import { SshConnectionsTab } from './SshConnectionsTab';

type Section = 'systemVars' | 'connections';

/**
 * The "Environment" view shell. Hosts two top-level tabs:
 *   - "System variables" — the read-only env snapshot (user/root sub-tabs).
 *   - "Connections" — the read-only SSH host inventory.
 *
 * The top-level tabs use a dedicated `env-manager__section-tab*` class family
 * so they don't collide with the user/root sub-tabs inside SystemVarsTab
 * (which keep the existing `env-manager__tab*` classes).
 */
export function EnvManager(): ReactElement {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>('systemVars');

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t('envManager.title')}</h1>
          <p className="view-subtitle">{t('envManager.subtitle')}</p>
        </div>
      </header>

      <div className="env-manager__section-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'systemVars'}
          className={`env-manager__section-tab${
            section === 'systemVars' ? ' is-active' : ''
          }`}
          onClick={() => setSection('systemVars')}
        >
          {t('envManager.sectionTabs.systemVars', { defaultValue: 'System variables' })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'connections'}
          className={`env-manager__section-tab${
            section === 'connections' ? ' is-active' : ''
          }`}
          onClick={() => setSection('connections')}
        >
          {t('envManager.sectionTabs.connections', { defaultValue: 'Connections' })}
        </button>
      </div>

      {section === 'systemVars' ? <SystemVarsTab /> : <SshConnectionsTab />}
    </div>
  );
}
