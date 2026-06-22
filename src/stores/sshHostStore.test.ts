// Unit tests for the SSH host store. IPC is mocked so the tests never cross
// the Tauri boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshHostView, SshInventoryView } from '../types/sshHost';

vi.mock('../services/sshConnectionService', () => ({
  listSshHosts: vi.fn(),
  checkSshHost: vi.fn(),
  saveSshHost: vi.fn(),
  deleteSshHost: vi.fn(),
}));

import {
  listSshHosts,
  checkSshHost,
  saveSshHost,
  deleteSshHost,
} from '../services/sshConnectionService';
import { useSshHostStore, hostKey, selectCheckState } from './sshHostStore';

function makeHost(name: string, overrides: Partial<SshHostView> = {}): SshHostView {
  return {
    id: { source: 'open-ssh-config', name },
    name,
    hostName: `${name}.example.com`,
    user: 'deploy',
    port: 22,
    identityFile: null,
    editableParams: true,
    editableName: true,
    deletable: true,
    sourceDetail: '/home/u/.ssh/config',
    rawText: `Host ${name}`,
    lastCheckAt: null,
    lastCheckOk: null,
    ...overrides,
  };
}

const inventory: SshInventoryView = {
  hosts: [makeHost('prod'), makeHost('staging')],
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

describe('hostKey', () => {
  it('matches the backend composite key format', () => {
    expect(hostKey('open-ssh-config', 'prod')).toBe('open-ssh-config:prod');
    expect(hostKey('putty', 'prod')).toBe('putty:prod');
  });
});

describe('load', () => {
  it('populates hosts and sources on success', async () => {
    vi.mocked(listSshHosts).mockResolvedValue(inventory);

    await useSshHostStore.getState().load();

    const s = useSshHostStore.getState();
    expect(s.hosts).toHaveLength(2);
    expect(s.sources).toHaveLength(1);
    expect(s.isLoading).toBe(false);
    expect(s.loadError).toBeNull();
  });

  it('records loadError and clears isLoading when the IPC rejects', async () => {
    vi.mocked(listSshHosts).mockRejectedValue(new Error('ipc boom'));

    await useSshHostStore.getState().load();

    const s = useSshHostStore.getState();
    expect(s.loadError).toContain('ipc boom');
    expect(s.isLoading).toBe(false);
    expect(s.hosts).toHaveLength(0);
  });
});

describe('check', () => {
  it('sets checking then done with a reachable result', async () => {
    vi.mocked(checkSshHost).mockResolvedValue({ reachable: true, message: 'reachable' });
    const host = makeHost('prod');
    useSshHostStore.setState({ hosts: [host] });

    await useSshHostStore.getState().check(host);

    const state = useSshHostStore.getState();
    const cs = selectCheckState(state, 'open-ssh-config', 'prod');
    expect(cs.kind).toBe('done');
    if (cs.kind === 'done') {
      expect(cs.result.reachable).toBe(true);
    }
  });

  it('passes the alias (host name) and composite key to the service', async () => {
    vi.mocked(checkSshHost).mockResolvedValue({ reachable: false, message: 'no' });
    const host = makeHost('prod');

    await useSshHostStore.getState().check(host);

    expect(checkSshHost).toHaveBeenCalledWith('prod', 'open-ssh-config:prod');
  });

  it('reflects the fresh result on the host row (lastCheckOk)', async () => {
    vi.mocked(checkSshHost).mockResolvedValue({ reachable: true, message: 'reachable' });
    const host = makeHost('prod', { lastCheckOk: null });
    useSshHostStore.setState({ hosts: [host] });

    await useSshHostStore.getState().check(host);

    const updated = useSshHostStore.getState().hosts.find((h) => h.name === 'prod');
    expect(updated?.lastCheckOk).toBe(true);
    expect(updated?.lastCheckAt).not.toBeNull();
  });

  it('surfaces an IPC fault as a done state with reachable:false', async () => {
    vi.mocked(checkSshHost).mockRejectedValue(new Error('ipc fault'));
    const host = makeHost('prod');

    await useSshHostStore.getState().check(host);

    const cs = selectCheckState(useSshHostStore.getState(), 'open-ssh-config', 'prod');
    expect(cs.kind).toBe('done');
    if (cs.kind === 'done') {
      expect(cs.result.reachable).toBe(false);
      expect(cs.result.message).toContain('ipc fault');
    }
  });
});

describe('selectCheckState', () => {
  it('returns idle for a host that has not been checked', () => {
    const cs = selectCheckState(useSshHostStore.getState(), 'open-ssh-config', 'unknown');
    expect(cs.kind).toBe('idle');
  });
});

describe('save', () => {
  it('applies the refreshed inventory the backend returns', async () => {
    const refreshed: SshInventoryView = {
      hosts: [makeHost('prod'), makeHost('newhost')],
      patterns: [],
      sources: inventory.sources,
    };
    vi.mocked(saveSshHost).mockResolvedValue(refreshed);

    await useSshHostStore.getState().save('open-ssh-config', {
      name: 'newhost',
      previousName: null,
      hostName: 'n.example.com',
      user: null,
      port: null,
      identityFile: null,
    });

    expect(saveSshHost).toHaveBeenCalledWith('open-ssh-config', expect.objectContaining({
      name: 'newhost',
    }));
    expect(useSshHostStore.getState().hosts).toHaveLength(2);
    expect(useSshHostStore.getState().loadError).toBeNull();
  });

  it('propagates the error so the form can show it (no state mutation)', async () => {
    vi.mocked(saveSshHost).mockRejectedValue(new Error('host is read-only'));
    useSshHostStore.setState({ hosts: [makeHost('prod')] });

    await expect(
      useSshHostStore.getState().save('open-ssh-config', {
        name: 'prod',
        previousName: null,
        hostName: null,
        user: null,
        port: null,
        identityFile: null,
      }),
    ).rejects.toThrow('host is read-only');

    // Inventory is unchanged on failure.
    expect(useSshHostStore.getState().hosts).toHaveLength(1);
  });
});

describe('remove', () => {
  it('applies the refreshed inventory the backend returns', async () => {
    const refreshed: SshInventoryView = {
      hosts: [makeHost('prod')],
      patterns: [],
      sources: inventory.sources,
    };
    vi.mocked(deleteSshHost).mockResolvedValue(refreshed);
    useSshHostStore.setState({ hosts: [makeHost('prod'), makeHost('gone')] });

    await useSshHostStore.getState().remove('open-ssh-config', 'gone');

    expect(deleteSshHost).toHaveBeenCalledWith('open-ssh-config', 'gone');
    const names = useSshHostStore.getState().hosts.map((h) => h.name);
    expect(names).toEqual(['prod']);
  });
});
