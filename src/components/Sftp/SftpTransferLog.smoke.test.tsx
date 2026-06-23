import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import '../../i18n';
import { SftpTransferLog } from './SftpTransferLog';
import { useSftpStore, type TransferLogEntry } from '../../stores/sftpStore';

const ERROR_MSG = 'Couldn\'t write to remote file "/remote/a.txt": Permission denied';

/** The summary toggle is the only button carrying `aria-expanded`. */
function summaryButton(): HTMLElement {
  const btn = document.querySelector('button[aria-expanded]');
  if (btn === null) throw new Error('summary button not found');
  return btn as HTMLElement;
}

function seedLog(entries: TransferLogEntry[]): void {
  useSftpStore.setState({ transferLog: entries });
}

function okEntry(name: string): TransferLogEntry {
  return { id: 1, name, mode: 'copy', direction: 'upload', ok: true, error: null, at: 0 };
}

function errorEntry(name: string): TransferLogEntry {
  return { id: 2, name, mode: 'copy', direction: 'upload', ok: false, error: ERROR_MSG, at: 0 };
}

beforeEach(() => {
  seedLog([]);
});

afterEach(() => {
  seedLog([]);
});

describe('SftpTransferLog', () => {
  it('renders nothing when the log is empty', () => {
    const { container } = render(<SftpTransferLog />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a success summary and expands the list', () => {
    seedLog([okEntry('a.txt')]);
    render(<SftpTransferLog />);

    act(() => fireEvent.click(summaryButton()));

    expect(screen.getByText('a.txt')).toBeTruthy();
  });

  it('the error tooltip opens on hover and does NOT auto-hide on a timeout', async () => {
    seedLog([errorEntry('a.txt')]);
    render(<SftpTransferLog />);
    act(() => fireEvent.click(summaryButton()));

    // Hover the error message; the HoverTooltip wrapper is its parent.
    const errorText = screen.getAllByText(ERROR_MSG)[0];
    act(() => fireEvent.mouseEnter(errorText.parentElement as HTMLElement));

    // The portalled tooltip popover appears...
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Permission denied');

    // ...and stays open: unlike a native `title`, nothing closes it on a timer.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('Escape closes the error tooltip but is NOT expected to close the modal', async () => {
    seedLog([errorEntry('a.txt')]);
    render(<SftpTransferLog />);
    act(() => fireEvent.click(summaryButton()));

    const errorText = screen.getAllByText(ERROR_MSG)[0];
    act(() => fireEvent.mouseEnter(errorText.parentElement as HTMLElement));
    await screen.findByRole('tooltip');

    // Escape dismisses the (non-modal) tooltip popover.
    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    // The log panel (part of the modal) is unaffected — the row is still there.
    expect(screen.getAllByText(ERROR_MSG).length).toBeGreaterThan(0);
  });

  it('clearTransferLog empties the log via the Clear button', () => {
    seedLog([errorEntry('a.txt'), okEntry('b.txt')]);
    render(<SftpTransferLog />);
    act(() => fireEvent.click(summaryButton()));

    act(() => fireEvent.click(screen.getByRole('button', { name: /clear history|очистить историю/i })));
    expect(useSftpStore.getState().transferLog).toHaveLength(0);
  });
});
