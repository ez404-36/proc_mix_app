// Smoke tests for the SSH host create/edit form.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SshHostView } from '../../types/sshHost';

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
});
