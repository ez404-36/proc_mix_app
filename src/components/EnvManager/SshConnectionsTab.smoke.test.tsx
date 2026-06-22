// Smoke tests for the Connections tab. IPC is mocked via the service layer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { SshInventoryView } from '../../types/sshHost';

vi.mock('../../services/sshConnectionService', () => ({
  listSshHosts: vi.fn(),
  checkSshHost: vi.fn(),
  saveSshHost: vi.fn(),
  deleteSshHost: vi.fn(),
  subscribeSshConfigChanges: vi.fn(() => () => {}),
}));

import '../../i18n';
import { listSshHosts } from '../../services/sshConnectionService';
import { useSshHostStore } from '../../stores/sshHostStore';
import { SshConnectionsTab } from './SshConnectionsTab';

const inventory: SshInventoryView = {
  hosts: [
    {
      id: { source: 'open-ssh-config', name: 'prod' },
      name: 'prod',
      hostName: 'prod.example.com',
      user: 'deploy',
      port: 2222,
      identityFile: null,
      editableParams: true,
    editableName: true,
    deletable: true,
      sourceDetail: '/home/u/.ssh/config',
      rawText: 'Host prod\n    HostName prod.example.com',
      lastCheckAt: null,
      lastCheckOk: null,
    },
  ],
  patterns: [],
  sources: [
    { source: 'open-ssh-config', available: true, implemented: true, error: null },
  ],
};

function resetStore(): void {
  useSshHostStore.setState({
    hosts: [],
    patterns: [],
    sources: [],
    isLoading: false,
    loadError: null,
    checks: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

afterEach(() => {
  resetStore();
});

describe('SshConnectionsTab smoke', () => {
  it('renders a host row with its target after load', async () => {
    vi.mocked(listSshHosts).mockResolvedValue(inventory);

    await act(async () => {
      render(<SshConnectionsTab />);
    });

    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('deploy@prod.example.com:2222')).toBeTruthy();
  });

  it('shows the empty state when no hosts are found', async () => {
    vi.mocked(listSshHosts).mockResolvedValue({ hosts: [], patterns: [], sources: [] });

    await act(async () => {
      render(<SshConnectionsTab />);
    });

    // The empty-state copy mentions ~/.ssh/config.
    expect(screen.getByText(/\.ssh\/config/)).toBeTruthy();
  });

  it('renders a Check button per host', async () => {
    vi.mocked(listSshHosts).mockResolvedValue(inventory);

    await act(async () => {
      render(<SshConnectionsTab />);
    });

    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((b) => b.textContent ?? '');
    expect(labels.some((l) => /check|проверить/i.test(l))).toBe(true);
  });

  it('shows a Rules & templates section when patterns exist, collapsed by default', async () => {
    vi.mocked(listSshHosts).mockResolvedValue({
      hosts: inventory.hosts,
      patterns: [
        {
          id: { source: 'system-config', name: '*' },
          name: '*',
          hostName: null,
          user: 'ci',
          port: 22,
          identityFile: null,
          editableParams: false,
    editableName: false,
    deletable: false,
          sourceDetail: '/etc/ssh/ssh_config',
          rawText: 'Host *\n    User ci\n    Port 22',
          lastCheckAt: null,
          lastCheckOk: null,
        },
      ],
      sources: inventory.sources,
    });

    await act(async () => {
      render(<SshConnectionsTab />);
    });

    // The collapsible toggle is present...
    const toggle = screen.getByRole('button', { name: /rules & templates|правила и шаблоны/i });
    expect(toggle).toBeTruthy();
    // ...and collapsed by default: the pattern name is not shown yet.
    expect(screen.queryByText('*')).toBeNull();

    // Expanding reveals the pattern row (read-only, no Check button on it).
    await act(async () => {
      toggle.click();
    });
    expect(screen.getByText('*')).toBeTruthy();
  });
});
