// Smoke tests for the redesigned EnvManager view (read-only snapshot mode).
//
// Mocks all IPC so the test never crosses the Tauri boundary. Verifies the
// component mounts without crashing and renders its two-tab structure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('../../services/envSnapshotService', () => {
  const snap = {
    vars: [
      { key: 'HOME', value: '/home/user', sources: ['/etc/environment'] },
      { key: 'PATH', value: '/usr/bin:/bin', sources: ['/etc/environment', '/etc/profile'] },
      { key: 'MY_API_TOKEN', value: 'secret', sources: [] },
    ],
    files: [
      { path: '/etc/environment', readable: true, keys: ['HOME', 'PATH'] },
      { path: '/etc/profile', readable: true, keys: ['PATH'] },
    ],
  };
  return {
    getUserEnvWithSources: vi.fn().mockResolvedValue(snap),
    getRootEnvWithSources: vi.fn().mockResolvedValue(snap),
    openWindowsEnvDialog: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../../utils/adminPassword', () => ({
  hasAdminPassword: vi.fn().mockResolvedValue(false),
  setAdminPassword: vi.fn().mockResolvedValue(undefined),
  isAdminPasswordRequiredError: vi.fn().mockReturnValue(false),
  ADMIN_PASSWORD_REQUIRED: 'ADMIN_PASSWORD_REQUIRED',
  ADMIN_PASSWORD_BACKEND_PREFIX: 'ADMIN_PASSWORD_BACKEND:',
}));

vi.mock('../../utils/adminPasswordPrompt', () => ({
  promptForAdminPassword: vi.fn().mockResolvedValue(null),
}));

import '../../i18n';
import { useEnvManagerStore } from '../../stores/envManagerStore';
import { EnvManager } from './EnvManager';

function resetStore(): void {
  useEnvManagerStore.setState({
    userSnapshot: null,
    isUserLoading: false,
    rootState: { kind: 'idle' },
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe('EnvManager smoke', () => {
  it('renders the view title', async () => {
    await act(async () => {
      render(<EnvManager />);
    });
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('renders User and Root tab buttons', async () => {
    await act(async () => {
      render(<EnvManager />);
    });
    // Both tabs must be present.
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((b) => b.textContent ?? '');
    expect(labels.some((l) => /пользователь|user/i.test(l))).toBe(true);
    expect(labels.some((l) => /root/i.test(l))).toBe(true);
  });

  it('shows variable count badge after user snapshot loads', async () => {
    await act(async () => {
      render(<EnvManager />);
    });
    // After loadUser resolves the mock returns 3 vars — count badge "(3)"
    // should appear next to the User tab.
    expect(screen.getByText(/\(3\)/)).toBeTruthy();
  });
});
