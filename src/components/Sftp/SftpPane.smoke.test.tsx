// Smoke tests for SftpPane: rendering entries and drag-and-drop wiring.
// The store is driven via setState; the ContextMenu hook is mocked so the pane
// can render without the provider.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../ContextMenu', () => ({
  useContextMenu: () => ({ show: vi.fn(), hide: vi.fn() }),
}));

// The path field's folder-suggestion hook lists directories through the
// service; mock it so the component can render without a Tauri backend.
const listLocalDirMock = vi.fn();
vi.mock('../../services/sftpService', () => ({
  listLocalDir: (path: string) => listLocalDirMock(path),
  sftpListDir: vi.fn().mockResolvedValue({ path: '/', entries: [] }),
}));

import '../../i18n';
import { useSftpStore } from '../../stores/sftpStore';
import { DRAG_MIME } from '../../types/sftp';
import { SftpPane } from './SftpPane';

/** A minimal DataTransfer stub for jsdom (which lacks a real one). */
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, val: string) => store.set(type, val),
    getData: (type: string) => store.get(type) ?? '',
    setDragImage: () => {},
    get types() {
      return Array.from(store.keys());
    },
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function seedPanes(): void {
  useSftpStore.setState({
    alias: 'prod',
    local: {
      cwd: '/local',
      entries: [{ name: 'file.txt', kind: 'file', size: 10 }],
      isLoading: false,
      error: null,
      selection: [],
    },
    remote: {
      cwd: '/remote',
      entries: [{ name: 'sub', kind: 'dir', size: null }],
      isLoading: false,
      error: null,
      selection: [],
    },
    clipboard: null,
    drag: null,
    isTransferring: false,
  });
}

const noop = (): void => {};

beforeEach(() => {
  seedPanes();
  listLocalDirMock.mockReset();
  listLocalDirMock.mockResolvedValue({ path: '/local', entries: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SftpPane smoke', () => {
  it('renders the host title and entries', () => {
    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );
    expect(screen.getByText('localhost')).toBeTruthy();
    expect(screen.getByText('file.txt')).toBeTruthy();
    // The "up" row is present once a cwd is set.
    expect(screen.getByText('..')).toBeTruthy();
  });

  it('typing a path and pressing Enter navigates the pane', () => {
    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    useSftpStore.setState({ navigate: navigateSpy });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    expect(pathInput.value).toBe('/local');

    fireEvent.change(pathInput, { target: { value: '/local/sub' } });
    fireEvent.keyDown(pathInput, { key: 'Enter' });

    expect(navigateSpy).toHaveBeenCalledWith('local', '/local/sub');
  });

  it('Enter with the unchanged current path does not re-navigate', () => {
    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    useSftpStore.setState({ navigate: navigateSpy });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i);
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('Escape reverts an edited path back to the current directory', () => {
    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: '/typed/garbage' } });
    expect(pathInput.value).toBe('/typed/garbage');
    fireEvent.keyDown(pathInput, { key: 'Escape' });
    expect(pathInput.value).toBe('/local');
  });

  it('does not show a size for directory rows even when one is reported', () => {
    useSftpStore.setState({
      local: {
        cwd: '/local',
        entries: [
          { name: 'adir', kind: 'dir', size: 4096 },
          { name: 'afile.txt', kind: 'file', size: 2048 },
        ],
        isLoading: false,
        error: null,
        selection: [],
      },
    });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const dirRow = screen.getByText('adir').closest('li') as HTMLElement;
    const fileRow = screen.getByText('afile.txt').closest('li') as HTMLElement;
    // The directory's size cell is blank; the file's shows its size.
    expect(dirRow.querySelector('.sftp-row__size')?.textContent).toBe('');
    expect(fileRow.querySelector('.sftp-row__size')?.textContent).toBe('2.0 KB');
  });

  it('typing a path lists subdirectories as folder suggestions', async () => {
    listLocalDirMock.mockResolvedValue({
      path: '/local',
      entries: [
        { name: 'logs', kind: 'dir', size: null },
        { name: 'lost+found', kind: 'dir', size: null },
        { name: 'readme.txt', kind: 'file', size: 10 },
      ],
    });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    fireEvent.focus(pathInput);
    fireEvent.change(pathInput, { target: { value: '/local/lo' } });

    // The matching directories appear (files are excluded); the parent dir
    // ('/local') was listed for completion.
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy());
    expect(screen.getByText('lost+found')).toBeTruthy();
    expect(screen.queryByText('readme.txt')).toBeNull();
    expect(listLocalDirMock).toHaveBeenCalledWith('/local');
  });

  it('clicking a folder suggestion drills in with a trailing slash (no navigation)', async () => {
    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    useSftpStore.setState({ navigate: navigateSpy });
    // First round lists '/local'; after the click the hook lists '/local/logs'.
    listLocalDirMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/local/logs'
          ? { path, entries: [{ name: 'nested', kind: 'dir', size: null }] }
          : { path, entries: [{ name: 'logs', kind: 'dir', size: null }] },
      ),
    );

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    fireEvent.focus(pathInput);
    fireEvent.change(pathInput, { target: { value: '/local/lo' } });

    const option = await screen.findByText('logs');
    fireEvent.mouseDown(option);

    // The draft gains a trailing slash and the pane is NOT navigated yet.
    expect(pathInput.value).toBe('/local/logs/');
    expect(navigateSpy).not.toHaveBeenCalled();
    // The dropdown now lists the picked folder's children.
    await waitFor(() => expect(screen.getByText('nested')).toBeTruthy());
    expect(listLocalDirMock).toHaveBeenCalledWith('/local/logs');
  });

  it('Enter closes the suggestion dropdown until the field is re-focused', async () => {
    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    useSftpStore.setState({ navigate: navigateSpy });
    listLocalDirMock.mockResolvedValue({
      path: '/local',
      entries: [{ name: 'logs', kind: 'dir', size: null }],
    });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    fireEvent.focus(pathInput);
    fireEvent.change(pathInput, { target: { value: '/local/lo' } });
    await screen.findByText('logs');

    // Enter with no highlighted option navigates and closes the dropdown.
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    expect(navigateSpy).toHaveBeenCalledWith('local', '/local/lo');
    await waitFor(() => expect(screen.queryByText('logs')).toBeNull());

    // It stays closed (no auto-reopen) until a click/focus re-opens it.
    fireEvent.focus(pathInput);
    fireEvent.mouseDown(pathInput);
    await waitFor(() => expect(screen.getByText('logs')).toBeTruthy());
  });

  it('Escape closes the suggestion dropdown (keeping the typed draft)', async () => {
    listLocalDirMock.mockResolvedValue({
      path: '/local',
      entries: [{ name: 'logs', kind: 'dir', size: null }],
    });

    render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const pathInput = screen.getByLabelText(/current path/i) as HTMLInputElement;
    fireEvent.focus(pathInput);
    fireEvent.change(pathInput, { target: { value: '/local/lo' } });
    await screen.findByText('logs');

    // Escape with the dropdown open closes it but keeps the draft (does not revert).
    fireEvent.keyDown(pathInput, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('logs')).toBeNull());
    expect(pathInput.value).toBe('/local/lo');
  });

  it('drag from local + drop on the remote pane calls transfer with mode copy', () => {
    const transferSpy = vi.fn().mockResolvedValue({ ok: true, failed: [] });
    useSftpStore.setState({ transfer: transferSpy });

    const { rerender } = render(
      <SftpPane
        side="local"
        title="localhost"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const dt = makeDataTransfer();
    const fileRow = screen.getByText('file.txt').closest('li') as HTMLElement;
    act(() => {
      fireEvent.dragStart(fileRow, { dataTransfer: dt });
    });

    // The drag payload was published to the store and the dataTransfer.
    expect(useSftpStore.getState().drag).toEqual({ side: 'local', paths: ['/local/file.txt'] });

    // Render the remote pane and drop onto its body.
    rerender(
      <SftpPane
        side="remote"
        title="prod"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );
    const remoteBody = screen.getByText('sub').closest('.sftp-pane__body') as HTMLElement;
    act(() => {
      fireEvent.drop(remoteBody, { dataTransfer: dt });
    });

    // Drag-and-drop always COPIES (never moves) — the source is left intact.
    expect(transferSpy).toHaveBeenCalledWith({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/file.txt'],
      toDir: '/remote',
      mode: 'copy',
    });
  });

  it('even a Ctrl-drag drop copies (drag-and-drop never moves)', () => {
    const transferSpy = vi.fn().mockResolvedValue({ ok: true, failed: [] });
    useSftpStore.setState({
      transfer: transferSpy,
      drag: { side: 'local', paths: ['/local/file.txt'] },
    });

    render(
      <SftpPane
        side="remote"
        title="prod"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const dt = makeDataTransfer();
    dt.setData(DRAG_MIME, JSON.stringify({ side: 'local', paths: ['/local/file.txt'] }));
    const remoteBody = screen.getByText('sub').closest('.sftp-pane__body') as HTMLElement;
    act(() => {
      const evt = new MouseEvent('drop', { bubbles: true, cancelable: true, ctrlKey: true });
      Object.defineProperty(evt, 'dataTransfer', { value: dt });
      remoteBody.dispatchEvent(evt);
    });

    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(transferSpy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'copy', toSide: 'remote' }),
    );
  });

  it('shows "Copy to this folder" when dragging over a directory row', () => {
    useSftpStore.setState({ drag: { side: 'local', paths: ['/local/file.txt'] } });
    render(
      <SftpPane
        side="remote"
        title="prod"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const dt = makeDataTransfer();
    dt.setData(DRAG_MIME, JSON.stringify({ side: 'local', paths: ['/local/file.txt'] }));
    const dirRow = screen.getByText('sub').closest('li') as HTMLElement;
    act(() => {
      fireEvent.dragOver(dirRow, { dataTransfer: dt });
    });

    expect(screen.getByText(/copy to this folder|скопировать в эту папку/i)).toBeTruthy();
  });

  it('shows "Copy here" when dragging over the empty pane body', () => {
    useSftpStore.setState({ drag: { side: 'local', paths: ['/local/file.txt'] } });
    render(
      <SftpPane
        side="remote"
        title="prod"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    const dt = makeDataTransfer();
    dt.setData(DRAG_MIME, JSON.stringify({ side: 'local', paths: ['/local/file.txt'] }));
    const body = screen.getByText('sub').closest('.sftp-pane__body') as HTMLElement;
    act(() => {
      fireEvent.dragOver(body, { dataTransfer: dt });
    });

    expect(screen.getByText(/copy here|скопировать сюда/i)).toBeTruthy();
  });

  it('hides dotfiles by default and reveals them when "show hidden" is on', () => {
    useSftpStore.setState({
      remote: {
        cwd: '/remote',
        entries: [
          { name: '.bashrc', kind: 'file', size: 10 },
          { name: '.config', kind: 'dir', size: null },
          { name: 'visible.txt', kind: 'file', size: 20 },
        ],
        isLoading: false,
        error: null,
        selection: [],
      },
    });

    render(
      <SftpPane
        side="remote"
        title="prod"
        onPromptNewFolder={noop}
        onPromptRename={noop}
        onRequestDelete={noop}
      />,
    );

    // Default: dotfiles hidden, normal entry shown.
    expect(screen.queryByText('.bashrc')).toBeNull();
    expect(screen.queryByText('.config')).toBeNull();
    expect(screen.getByText('visible.txt')).toBeTruthy();

    // Toggle on → dotfiles appear.
    const toggle = screen.getByRole('checkbox', { name: /show hidden|показать скрытые/i });
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.getByText('.bashrc')).toBeTruthy();
    expect(screen.getByText('.config')).toBeTruthy();

    // Toggle off → hidden again.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByText('.bashrc')).toBeNull();
  });
});
