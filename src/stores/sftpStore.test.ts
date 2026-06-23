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
  localRename,
  sftpDelete,
  sftpDownload,
  sftpListDir,
  sftpRename,
  sftpUpload,
} from '../services/sftpService';
import { joinPath, parentDir, useSftpStore } from './sftpStore';
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
