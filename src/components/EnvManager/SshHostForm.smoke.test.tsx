// Smoke tests for the SSH host create/edit form.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SshHostView } from '../../types/sshHost';

// Arco's `Message` toast renders via a legacy ReactDOM.render path that throws
// in jsdom — stub it so the save/clear success toasts don't crash the test.
vi.mock('@arco-design/web-react', () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

// Saved-password controls call the SSH connection service + platform helper.
// Mock both so the form renders deterministically (Unix, no saved password by
// default) without a Tauri backend.
const hasSshPasswordMock = vi.fn();
const setSshPasswordMock = vi.fn();
const clearSshPasswordMock = vi.fn();
vi.mock('../../services/sshConnectionService', () => ({
  hasSshPassword: (alias: string) => hasSshPasswordMock(alias),
  setSshPassword: (alias: string, password: string) => setSshPasswordMock(alias, password),
  clearSshPassword: (alias: string) => clearSshPasswordMock(alias),
}));
const getCachedPlatformMock = vi.fn();
vi.mock('../../utils/platform', () => ({
  getCachedPlatform: () => getCachedPlatformMock(),
}));

import '../../i18n';
import { SshHostForm } from './SshHostForm';

function editableHost(): SshHostView {
  return {
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
  };
}

beforeEach(() => {
  getCachedPlatformMock.mockReturnValue('linux');
  hasSshPasswordMock.mockResolvedValue(false);
  setSshPasswordMock.mockResolvedValue(undefined);
  clearSshPasswordMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SshHostForm', () => {
  it('prefills fields when editing an existing host', () => {
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={vi.fn()} />);
    expect((screen.getByLabelText(/^host$/i) as HTMLInputElement).value).toBe('prod');
    expect((screen.getByLabelText(/hostname/i) as HTMLInputElement).value).toBe('prod.example.com');
    expect((screen.getByLabelText(/^port$/i) as HTMLInputElement).value).toBe('2222');
  });

  it('builds a draft and calls onSave on submit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<SshHostForm host={null} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/^host$/i), {
      target: { value: 'newbox' },
    });
    fireEvent.change(screen.getByLabelText(/hostname/i), {
      target: { value: 'n.example.com' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save|сохранить/i }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0][0];
    expect(draft.name).toBe('newbox');
    expect(draft.hostName).toBe('n.example.com');
    expect(draft.previousName).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects an invalid alias without calling onSave', async () => {
    const onSave = vi.fn();
    render(<SshHostForm host={null} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/^host$/i), {
      target: { value: '-bad' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save|сохранить/i }));
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends previousName when the alias is renamed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/^host$/i), {
      target: { value: 'renamed' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save|сохранить/i }));
    });

    expect(onSave.mock.calls[0][0].previousName).toBe('prod');
  });

  it('shows a backend error inline and keeps the form open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('host is read-only'));
    const onClose = vi.fn();
    render(<SshHostForm host={null} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/^host$/i), {
      target: { value: 'newbox' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save|сохранить/i }));
    });

    expect(screen.getByText(/host is read-only/i)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers the saved-password control when editing a concrete host (Unix)', async () => {
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(hasSshPasswordMock).toHaveBeenCalledWith('prod'));
    expect(screen.getByText(/set password|задать пароль/i)).toBeTruthy();
  });

  it('does NOT offer the saved-password control when creating a host', () => {
    render(<SshHostForm host={null} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(hasSshPasswordMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/set password|задать пароль/i)).toBeNull();
  });

  it('hides the saved-password control on Windows', () => {
    getCachedPlatformMock.mockReturnValue('windows');
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(hasSshPasswordMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/set password|задать пароль/i)).toBeNull();
  });

  it('saves a typed password to the keychain under the host alias', async () => {
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(hasSshPasswordMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /set password|задать пароль/i }));
    const input = screen.getByLabelText(/ssh password for|пароль ssh для/i);
    fireEvent.change(input, { target: { value: 'hunter2' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save password|сохранить пароль/i }));
    });

    expect(setSshPasswordMock).toHaveBeenCalledWith('prod', 'hunter2');
  });

  it('clears a saved password', async () => {
    hasSshPasswordMock.mockResolvedValue(true);
    render(<SshHostForm host={editableHost()} onClose={vi.fn()} onSave={vi.fn()} />);
    const clearBtn = await screen.findByRole('button', { name: /^clear$|^очистить$/i });

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    expect(clearSshPasswordMock).toHaveBeenCalledWith('prod');
  });
});
