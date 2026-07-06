// Unit tests for the SFTP store's transfer/move semantics. The service layer
// (IPC) is mocked, so these assert the store's orchestration logic:
//   - the right primitive is chosen per transfer direction;
//   - a MOVE deletes the source only after a confirmed-successful transfer;
//   - a FAILED transfer never deletes the source;
//   - a same-pane rename does not issue a redundant separate delete.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/sftpService', () => ({
  sftpListDir: vi.fn(),
  listLocalDir: vi.fn(),
  sftpDownload: vi.fn(),
  sftpUpload: vi.fn(),
  sftpDelete: vi.fn(),
  sftpRename: vi.fn(),
  sftpMkdir: vi.fn(),
  localDelete: vi.fn(),
  localRename: vi.fn(),
  localMkdir: vi.fn(),
}));

import {
  listLocalDir,
  localDelete,
  localMkdir,
  localRename,
  sftpDelete,
  sftpDownload,
  sftpListDir,
  sftpMkdir,
  sftpRename,
  sftpUpload,
} from '../services/sftpService';
import { joinPath, parentDir, selectPane, useSftpStore } from './sftpStore';
import type { LocalListing, SftpListing } from '../types/sftp';

const emptyRemote: SftpListing = { path: '/remote', entries: [] };
const emptyLocal: LocalListing = { path: '/local', entries: [] };

function resetStore(): void {
  useSftpStore.setState({
    alias: 'prod',
    local: { cwd: '/local', entries: [], isLoading: false, error: null, selection: [] },
    remote: { cwd: '/remote', entries: [], isLoading: false, error: null, selection: [] },
    clipboard: null,
    drag: null,
    isTransferring: false,
    transferLog: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // refresh() after a transfer re-lists both panes; return empty listings.
  vi.mocked(sftpListDir).mockResolvedValue(emptyRemote);
  vi.mocked(listLocalDir).mockResolvedValue(emptyLocal);
  vi.mocked(sftpUpload).mockResolvedValue(undefined);
  vi.mocked(sftpDownload).mockResolvedValue(undefined);
  vi.mocked(sftpDelete).mockResolvedValue(undefined);
  vi.mocked(sftpRename).mockResolvedValue(undefined);
  vi.mocked(localDelete).mockResolvedValue(undefined);
  vi.mocked(localRename).mockResolvedValue(undefined);
  vi.mocked(sftpMkdir).mockResolvedValue(undefined);
  vi.mocked(localMkdir).mockResolvedValue(undefined);
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe('path helpers', () => {
  it('joinPath joins without doubling slashes', () => {
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });

  it('joinPath: an absolute name replaces the dir (no mangled concat)', () => {
    // Guards the `//home///home/x` bug: a typed absolute destination must
    // replace the base, not append to it.
    expect(joinPath('/home/user', '/etc/hosts')).toBe('/etc/hosts');
    expect(joinPath('.', '/home/e.zenkin')).toBe('/home/e.zenkin');
  });

  it('joinPath collapses accidental runs of slashes', () => {
    expect(joinPath('/a//', 'b')).toBe('/a/b');
    expect(joinPath('//home//', 'sub')).toBe('/home/sub');
  });

  it('parentDir returns the parent, / at the root', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/a/')).toBe('/');
  });
});

describe('transfer — copy (no source delete)', () => {
  it('local→remote copy uploads and never deletes the source', async () => {
    const result = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/file.txt'],
      toDir: '/remote/dir',
      mode: 'copy',
    });

    expect(sftpUpload).toHaveBeenCalledWith('prod', '/local/file.txt', '/remote/dir/file.txt');
    expect(localDelete).not.toHaveBeenCalled();
    expect(sftpDelete).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, failed: [] });
  });

  it('remote→local copy downloads and never deletes the source', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'local',
      paths: ['/remote/data.bin'],
      toDir: '/local/dl',
      mode: 'copy',
    });

    expect(sftpDownload).toHaveBeenCalledWith('prod', '/remote/data.bin', '/local/dl/data.bin');
    expect(sftpDelete).not.toHaveBeenCalled();
  });
});

describe('transfer — move (delete source only after success)', () => {
  it('local→remote move uploads THEN deletes the local source', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/file.txt'],
      toDir: '/remote/dir',
      mode: 'move',
    });

    expect(sftpUpload).toHaveBeenCalledWith('prod', '/local/file.txt', '/remote/dir/file.txt');
    // Source removed via the local-fs delete (file-first attempt).
    expect(localDelete).toHaveBeenCalledWith('/local/file.txt', false);
  });

  it('a FAILED upload does NOT delete the source (move)', async () => {
    vi.mocked(sftpUpload).mockRejectedValueOnce(new Error('connection lost'));

    const result = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/file.txt'],
      toDir: '/remote/dir',
      mode: 'move',
    });

    expect(localDelete).not.toHaveBeenCalled();
    expect(sftpDelete).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['/local/file.txt']);
  });

  it('partial failure: only the successful item is deleted', async () => {
    vi.mocked(sftpUpload)
      .mockResolvedValueOnce(undefined) // a.txt OK
      .mockRejectedValueOnce(new Error('boom')); // b.txt fails

    const result = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/a.txt', '/local/b.txt'],
      toDir: '/remote',
      mode: 'move',
    });

    expect(localDelete).toHaveBeenCalledTimes(1);
    expect(localDelete).toHaveBeenCalledWith('/local/a.txt', false);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['/local/b.txt']);
  });
});

describe('transfer — same-pane rename (atomic move, no extra delete)', () => {
  it('remote→remote move renames and does NOT issue a separate delete', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'remote',
      paths: ['/remote/old.txt'],
      toDir: '/remote/sub',
      mode: 'move',
    });

    expect(sftpRename).toHaveBeenCalledWith('prod', '/remote/old.txt', '/remote/sub/old.txt');
    // The rename already relocated it — no follow-up sftpDelete.
    expect(sftpDelete).not.toHaveBeenCalled();
  });

  it('local→local move uses local rename and no separate delete', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'local',
      paths: ['/local/old.txt'],
      toDir: '/local/sub',
      mode: 'move',
    });

    expect(localRename).toHaveBeenCalledWith('/local/old.txt', '/local/sub/old.txt');
    expect(localDelete).not.toHaveBeenCalled();
  });

  it('skips a no-op move into the same location', async () => {
    const result = await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'remote',
      paths: ['/remote/x.txt'],
      toDir: '/remote',
      mode: 'move',
    });

    expect(sftpRename).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, failed: [] });
  });
});

describe('clipboard paste', () => {
  it('a successful cut+paste consumes the clipboard', async () => {
    useSftpStore.getState().cut('local', ['/local/f.txt']);
    expect(useSftpStore.getState().clipboard).not.toBeNull();

    await useSftpStore.getState().paste('remote', '/remote');

    expect(sftpUpload).toHaveBeenCalled();
    expect(useSftpStore.getState().clipboard).toBeNull();
  });

  it('a copy+paste keeps the clipboard for re-paste', async () => {
    useSftpStore.getState().copy('local', ['/local/f.txt']);

    await useSftpStore.getState().paste('remote', '/remote');

    expect(useSftpStore.getState().clipboard).not.toBeNull();
  });
});

describe('transfer log', () => {
  it('records a successful upload (newest-first, with direction)', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/a.txt'],
      toDir: '/remote',
      mode: 'copy',
    });

    const log = useSftpStore.getState().transferLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      name: 'a.txt',
      direction: 'upload',
      mode: 'copy',
      ok: true,
      error: null,
    });
  });

  it('records a failed upload with the backend error message', async () => {
    vi.mocked(sftpUpload).mockRejectedValueOnce(
      new Error('Couldn\'t write to remote file "/remote/a.txt": Permission denied'),
    );

    const res = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/a.txt'],
      toDir: '/remote',
      mode: 'copy',
    });

    expect(res.ok).toBe(false);
    const log = useSftpStore.getState().transferLog;
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(false);
    expect(log[0].error).toContain('Permission denied');
  });

  it('logs newest-first across multiple files and clearTransferLog empties it', async () => {
    await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'local',
      paths: ['/remote/one.txt', '/remote/two.txt'],
      toDir: '/local',
      mode: 'copy',
    });

    const log = useSftpStore.getState().transferLog;
    expect(log.map((e) => e.name)).toEqual(['two.txt', 'one.txt']);
    expect(log.every((e) => e.direction === 'download')).toBe(true);

    useSftpStore.getState().clearTransferLog();
    expect(useSftpStore.getState().transferLog).toHaveLength(0);
  });
});

describe('openSession', () => {
  it('sets the alias and loads both panes from their home dirs', async () => {
    vi.mocked(listLocalDir).mockResolvedValueOnce({
      path: '/home/user',
      entries: [{ name: 'a.txt', kind: 'file', size: 1 }],
    });
    vi.mocked(sftpListDir).mockResolvedValueOnce({
      path: '/home/deploy',
      entries: [{ name: 'r.txt', kind: 'file', size: 2, modified: null, permissions: null }],
    });

    await useSftpStore.getState().openSession('stage', '/home/user', '/home/deploy');

    const s = useSftpStore.getState();
    expect(s.alias).toBe('stage');
    expect(s.local.cwd).toBe('/home/user');
    expect(s.local.entries.map((e) => e.name)).toEqual(['a.txt']);
    expect(s.remote.cwd).toBe('/home/deploy');
    expect(s.remote.entries.map((e) => e.name)).toEqual(['r.txt']);
    expect(listLocalDir).toHaveBeenCalledWith('/home/user');
    expect(sftpListDir).toHaveBeenCalledWith('stage', '/home/deploy');
  });
});

describe('navigate', () => {
  it('sorts directories first then case-insensitive by name', async () => {
    vi.mocked(listLocalDir).mockResolvedValueOnce({
      path: '/local',
      entries: [
        { name: 'Zebra', kind: 'file', size: 1 },
        { name: 'apple', kind: 'file', size: 2 },
        { name: 'src', kind: 'dir', size: null },
        { name: 'Docs', kind: 'dir', size: null },
      ],
    });
    await useSftpStore.getState().navigate('local', '/local');
    const names = useSftpStore.getState().local.entries.map((e) => e.name);
    expect(names).toEqual(['Docs', 'src', 'apple', 'Zebra']);
  });

  it('records the error on the pane when the listing rejects', async () => {
    vi.mocked(sftpListDir).mockRejectedValueOnce(new Error('host unreachable'));
    await useSftpStore.getState().navigate('remote', '/remote/broken');
    const remote = useSftpStore.getState().remote;
    expect(remote.isLoading).toBe(false);
    expect(remote.error).toBe('host unreachable');
  });

  it('stringifies a non-Error rejection', async () => {
    vi.mocked(sftpListDir).mockRejectedValueOnce('plain failure');
    await useSftpStore.getState().navigate('remote', '/remote/x');
    expect(useSftpStore.getState().remote.error).toBe('plain failure');
  });
});

describe('refresh', () => {
  it('is a no-op when the pane has no cwd yet', async () => {
    useSftpStore.setState({
      local: { cwd: null, entries: [], isLoading: false, error: null, selection: [] },
    });
    await useSftpStore.getState().refresh('local');
    expect(listLocalDir).not.toHaveBeenCalled();
  });

  it('re-navigates the pane to its current directory', async () => {
    await useSftpStore.getState().refresh('remote');
    expect(sftpListDir).toHaveBeenCalledWith('prod', '/remote');
  });

  it('surfaces a "no remote host" pane when refreshing remote with no alias', async () => {
    useSftpStore.setState({ alias: null });
    await useSftpStore.getState().refresh('remote');
    // loadPane's remote-no-alias branch returns an error pane; sftpListDir is skipped.
    expect(sftpListDir).not.toHaveBeenCalled();
    expect(useSftpStore.getState().remote.error).toBe('no remote host selected');
  });
});

describe('setSelection', () => {
  it('replaces the pane selection', () => {
    useSftpStore.getState().setSelection('local', ['a', 'b']);
    expect(useSftpStore.getState().local.selection).toEqual(['a', 'b']);
    useSftpStore.getState().setSelection('local', ['c']);
    expect(useSftpStore.getState().local.selection).toEqual(['c']);
  });
});

describe('remove', () => {
  it('deletes each remote entry then refreshes', async () => {
    await useSftpStore.getState().remove('remote', [
      { path: '/remote/a.txt', isDir: false },
      { path: '/remote/dir', isDir: true },
    ]);
    expect(sftpDelete).toHaveBeenCalledWith('prod', '/remote/a.txt', false);
    expect(sftpDelete).toHaveBeenCalledWith('prod', '/remote/dir', true);
    // refresh re-lists the remote pane.
    expect(sftpListDir).toHaveBeenCalledWith('prod', '/remote');
  });

  it('skips remote deletes when no alias is selected', async () => {
    useSftpStore.setState({ alias: null });
    await useSftpStore.getState().remove('remote', [
      { path: '/remote/a.txt', isDir: false },
    ]);
    expect(sftpDelete).not.toHaveBeenCalled();
  });

  it('deletes local entries via localDelete', async () => {
    await useSftpStore.getState().remove('local', [
      { path: '/local/a.txt', isDir: false },
    ]);
    expect(localDelete).toHaveBeenCalledWith('/local/a.txt', false);
    expect(listLocalDir).toHaveBeenCalledWith('/local');
  });

  it('records the pane error when a delete throws (before the follow-up refresh)', async () => {
    vi.mocked(localDelete).mockRejectedValueOnce(new Error('permission denied'));
    // Make the follow-up refresh also fail so the error survives to assert on.
    vi.mocked(listLocalDir).mockRejectedValue(new Error('permission denied'));
    await useSftpStore.getState().remove('local', [
      { path: '/local/a.txt', isDir: false },
    ]);
    expect(useSftpStore.getState().local.error).toBe('permission denied');
    expect(localDelete).toHaveBeenCalledWith('/local/a.txt', false);
    expect(listLocalDir).toHaveBeenCalled();
  });

  it('stringifies a non-Error delete rejection', async () => {
    vi.mocked(sftpDelete).mockRejectedValueOnce('boom');
    // The follow-up refresh also fails with the same string so it persists.
    vi.mocked(sftpListDir).mockRejectedValue('boom');
    await useSftpStore.getState().remove('remote', [
      { path: '/remote/a.txt', isDir: false },
    ]);
    expect(useSftpStore.getState().remote.error).toBe('boom');
  });
});

describe('rename', () => {
  it('remote rename calls sftpRename then refreshes', async () => {
    await useSftpStore.getState().rename('remote', '/remote/old', '/remote/new');
    expect(sftpRename).toHaveBeenCalledWith('prod', '/remote/old', '/remote/new');
    expect(sftpListDir).toHaveBeenCalledWith('prod', '/remote');
  });

  it('remote rename returns early when no alias is selected', async () => {
    useSftpStore.setState({ alias: null });
    await useSftpStore.getState().rename('remote', '/remote/old', '/remote/new');
    expect(sftpRename).not.toHaveBeenCalled();
  });

  it('local rename calls localRename then refreshes', async () => {
    await useSftpStore.getState().rename('local', '/local/old', '/local/new');
    expect(localRename).toHaveBeenCalledWith('/local/old', '/local/new');
    expect(listLocalDir).toHaveBeenCalledWith('/local');
  });
});

describe('makeDir', () => {
  it('returns early when the pane has no cwd', async () => {
    useSftpStore.setState({
      remote: { cwd: null, entries: [], isLoading: false, error: null, selection: [] },
    });
    await useSftpStore.getState().makeDir('remote', 'new');
    expect(sftpMkdir).not.toHaveBeenCalled();
  });

  it('remote makeDir joins the path and refreshes', async () => {
    await useSftpStore.getState().makeDir('remote', 'newdir');
    expect(sftpMkdir).toHaveBeenCalledWith('prod', '/remote/newdir');
    expect(sftpListDir).toHaveBeenCalledWith('prod', '/remote');
  });

  it('remote makeDir returns early when no alias is selected', async () => {
    useSftpStore.setState({ alias: null });
    await useSftpStore.getState().makeDir('remote', 'newdir');
    expect(sftpMkdir).not.toHaveBeenCalled();
  });

  it('local makeDir joins the path and refreshes', async () => {
    await useSftpStore.getState().makeDir('local', 'newdir');
    expect(localMkdir).toHaveBeenCalledWith('/local/newdir');
    expect(listLocalDir).toHaveBeenCalledWith('/local');
  });
});

describe('closeSession', () => {
  it('resets all state to defaults', () => {
    useSftpStore.setState({
      clipboard: { mode: 'copy', side: 'local', paths: ['/x'] },
      isTransferring: true,
      transferLog: [
        { id: 1, name: 'x', mode: 'copy', direction: 'upload', ok: true, error: null, at: 0 },
      ],
    });
    useSftpStore.getState().closeSession();
    const s = useSftpStore.getState();
    expect(s.alias).toBeNull();
    expect(s.local.cwd).toBeNull();
    expect(s.remote.cwd).toBeNull();
    expect(s.clipboard).toBeNull();
    expect(s.drag).toBeNull();
    expect(s.isTransferring).toBe(false);
    expect(s.transferLog).toEqual([]);
  });
});

describe('deleteSource file→dir fallback', () => {
  it('retries a local delete as a directory when the file delete fails (move)', async () => {
    // The first localDelete(path, false) rejects, the retry (path, true) resolves.
    vi.mocked(localDelete)
      .mockRejectedValueOnce(new Error('is a directory'))
      .mockResolvedValueOnce(undefined);

    const result = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/somedir'],
      toDir: '/remote',
      mode: 'move',
    });

    expect(sftpUpload).toHaveBeenCalledWith('prod', '/local/somedir', '/remote/somedir');
    expect(localDelete).toHaveBeenNthCalledWith(1, '/local/somedir', false);
    expect(localDelete).toHaveBeenNthCalledWith(2, '/local/somedir', true);
    expect(result.ok).toBe(true);
  });

  it('retries a remote delete as a directory when the file delete fails (move)', async () => {
    vi.mocked(sftpDelete)
      .mockRejectedValueOnce(new Error('is a directory'))
      .mockResolvedValueOnce(undefined);

    await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'local',
      paths: ['/remote/somedir'],
      toDir: '/local',
      mode: 'move',
    });

    expect(sftpDownload).toHaveBeenCalledWith('prod', '/remote/somedir', '/local/somedir');
    expect(sftpDelete).toHaveBeenNthCalledWith(1, 'prod', '/remote/somedir', false);
    expect(sftpDelete).toHaveBeenNthCalledWith(2, 'prod', '/remote/somedir', true);
  });
});

describe('transferOne alias-null throws', () => {
  it('fails an upload when the alias is null', async () => {
    useSftpStore.setState({ alias: null });
    const result = await useSftpStore.getState().transfer({
      fromSide: 'local',
      toSide: 'remote',
      paths: ['/local/a.txt'],
      toDir: '/remote',
      mode: 'copy',
    });
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['/local/a.txt']);
    expect(sftpUpload).not.toHaveBeenCalled();
  });

  it('fails a download when the alias is null', async () => {
    useSftpStore.setState({ alias: null });
    const result = await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'local',
      paths: ['/remote/a.txt'],
      toDir: '/local',
      mode: 'copy',
    });
    expect(result.failed).toEqual(['/remote/a.txt']);
  });

  it('fails a remote→remote rename when the alias is null', async () => {
    useSftpStore.setState({ alias: null });
    const result = await useSftpStore.getState().transfer({
      fromSide: 'remote',
      toSide: 'remote',
      paths: ['/remote/a.txt'],
      toDir: '/remote/sub',
      mode: 'move',
    });
    expect(result.failed).toEqual(['/remote/a.txt']);
    expect(sftpRename).not.toHaveBeenCalled();
  });
});

describe('setDrag', () => {
  it('sets and clears the in-progress drag payload', () => {
    useSftpStore.getState().setDrag({ side: 'local', paths: ['/local/a.txt'] });
    expect(useSftpStore.getState().drag).toEqual({ side: 'local', paths: ['/local/a.txt'] });
    useSftpStore.getState().setDrag(null);
    expect(useSftpStore.getState().drag).toBeNull();
  });
});

describe('selectPane', () => {
  it('returns the local pane for the local side', () => {
    const state = useSftpStore.getState();
    expect(selectPane(state, 'local')).toBe(state.local);
  });

  it('returns the remote pane for the remote side', () => {
    const state = useSftpStore.getState();
    expect(selectPane(state, 'remote')).toBe(state.remote);
  });
});
