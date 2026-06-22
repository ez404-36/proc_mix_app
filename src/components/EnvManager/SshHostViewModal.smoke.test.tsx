// Smoke tests for the read-only SSH host view modal.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SshHostView } from '../../types/sshHost';

import '../../i18n';
import { SshHostViewModal } from './SshHostViewModal';

function host(overrides: Partial<SshHostView> = {}): SshHostView {
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
    rawText: 'Host prod\n    HostName prod.example.com\n    User deploy\n    Port 2222',
    lastCheckAt: null,
    lastCheckOk: null,
    ...overrides,
  };
}

describe('SshHostViewModal', () => {
  it('shows the parsed fields', () => {
    render(<SshHostViewModal host={host()} onClose={vi.fn()} />);
    expect(screen.getByText('prod.example.com')).toBeTruthy();
    expect(screen.getByText('deploy')).toBeTruthy();
    expect(screen.getByText('2222')).toBeTruthy();
  });

  it('shows the full raw block, including unmodelled directives', () => {
    const readOnly = host({
      editableParams: false,
    editableName: false,
    deletable: false,
      rawText: 'Host bastioned\n    HostName 10.0.0.5\n    ProxyJump gw',
    });
    render(<SshHostViewModal host={readOnly} onClose={vi.fn()} />);
    // The unmodelled ProxyJump line is only visible via the raw block.
    expect(screen.getByText(/ProxyJump gw/)).toBeTruthy();
  });

  it('renders an em-dash for unset fields', () => {
    render(<SshHostViewModal host={host({ identityFile: null })} onClose={vi.fn()} />);
    // IdentityFile is unset → shown as the not-set marker.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
