// Unit tests for the redesigned env-manager store.
// All IPC calls are mocked so the tests never cross the Tauri boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSnapshot = {
  vars: [{ key: 'HOME', value: '/home/u', sources: ['/etc/environment'] }],
  files: [{ path: '/etc/environment', readable: true, keys: ['HOME'] }],
};

vi.mock('../services/envSnapshotService', () => ({
  getUserEnvWithSources: vi.fn(),
  getRootEnvWithSources: vi.fn(),
  openWindowsEnvDialog: vi.fn().mockResolvedValue(false),
}));

vi.mock('../utils/adminPassword', () => ({
  isAdminPasswordRequiredError: vi.fn().mockImplementation(
    (err: unknown) => typeof err === 'string' && err === 'ADMIN_PASSWORD_REQUIRED',
  ),
  ADMIN_PASSWORD_REQUIRED: 'ADMIN_PASSWORD_REQUIRED',
  ADMIN_PASSWORD_BACKEND_PREFIX: 'ADMIN_PASSWORD_BACKEND:',
}));

import { getUserEnvWithSources, getRootEnvWithSources } from '../services/envSnapshotService';
import { useEnvManagerStore } from './envManagerStore';

function resetStore(): void {
  useEnvManagerStore.setState({
    userSnapshot: null,
    isUserLoading: false,
    rootState: { kind: 'idle' },
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

afterEach(() => {
  resetStore();
});

describe('loadUser', () => {
  it('sets userSnapshot on success', async () => {
    vi.mocked(getUserEnvWithSources).mockResolvedValue(mockSnapshot);

    await useEnvManagerStore.getState().loadUser();

    const s = useEnvManagerStore.getState();
    expect(s.userSnapshot).toEqual(mockSnapshot);
    expect(s.isUserLoading).toBe(false);
  });

  it('clears isUserLoading even when the IPC rejects', async () => {
    vi.mocked(getUserEnvWithSources).mockRejectedValue(new Error('ipc error'));

    await expect(useEnvManagerStore.getState().loadUser()).rejects.toThrow('ipc error');
    expect(useEnvManagerStore.getState().isUserLoading).toBe(false);
  });
});

describe('loadRoot', () => {
  it('transitions to loaded state on success', async () => {
    vi.mocked(getRootEnvWithSources).mockResolvedValue(mockSnapshot);

    await useEnvManagerStore.getState().loadRoot();

    const state = useEnvManagerStore.getState().rootState;
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.snapshot).toEqual(mockSnapshot);
    }
  });

  it('transitions to no_password when sentinel is returned', async () => {
    // The Rust command returns Err("ADMIN_PASSWORD_REQUIRED") — Tauri
    // propagates it as a rejected promise with the sentinel string.
    vi.mocked(getRootEnvWithSources).mockRejectedValue('ADMIN_PASSWORD_REQUIRED');

    await useEnvManagerStore.getState().loadRoot();

    expect(useEnvManagerStore.getState().rootState.kind).toBe('no_password');
  });

  it('transitions to error state for non-sentinel rejections', async () => {
    vi.mocked(getRootEnvWithSources).mockRejectedValue(new Error('sudo timeout'));

    await useEnvManagerStore.getState().loadRoot();

    const state = useEnvManagerStore.getState().rootState;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toContain('sudo timeout');
    }
  });

  it('shows loading state while the IPC is in flight', () => {
    // Don't await — inspect state while pending.
    let resolve!: (v: typeof mockSnapshot) => void;
    vi.mocked(getRootEnvWithSources).mockReturnValue(
      new Promise<typeof mockSnapshot>((r) => { resolve = r; }),
    );

    void useEnvManagerStore.getState().loadRoot();

    expect(useEnvManagerStore.getState().rootState.kind).toBe('loading');
    // Clean up.
    resolve(mockSnapshot);
  });
});
