// Typed wrappers around the SFTP file-transfer Tauri commands.
//
// `invoke` is confined to this service layer (project convention): the store
// and components call these functions, never `invoke` directly. Each function
// maps 1:1 to a `#[tauri::command]` in `src-tauri/src/commands/sftp.rs`.
//
// Auth (keys/agent or a saved per-host password) is handled entirely in the
// backend; no password value crosses this boundary. Errors reject with the
// backend's message string, which carries a sentinel prefix (see
// `SFTP_ERROR`) for an unsafe alias/path so the UI can localise.

import { invoke } from '@tauri-apps/api/core';
import type { LocalListing, SftpListing } from '../types/sftp';

/** List a remote directory over SFTP. */
export async function sftpListDir(alias: string, path: string): Promise<SftpListing> {
  return invoke<SftpListing>('sftp_list_dir', { alias, path });
}

/** List a local directory (the left pane) via the backend `std::fs` reader. */
export async function listLocalDir(path: string): Promise<LocalListing> {
  return invoke<LocalListing>('list_local_dir', { path });
}

/** Delete a local entry. `isDir` removes a directory recursively. */
export async function localDelete(path: string, isDir: boolean): Promise<void> {
  await invoke('local_delete', { path, isDir });
}

/** Rename/move a local entry (both absolute local paths). */
export async function localRename(from: string, to: string): Promise<void> {
  await invoke('local_rename', { from, to });
}

/** Create a local directory (its parent must already exist). */
export async function localMkdir(path: string): Promise<void> {
  await invoke('local_mkdir', { path });
}

/** Download a remote file to a local path. */
export async function sftpDownload(
  alias: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  await invoke('sftp_download', { alias, remotePath, localPath });
}

/** Upload a local file to a remote path. */
export async function sftpUpload(
  alias: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await invoke('sftp_upload', { alias, localPath, remotePath });
}

/** Delete a remote entry. `isDir` selects `rmdir` vs `rm`. */
export async function sftpDelete(alias: string, path: string, isDir: boolean): Promise<void> {
  await invoke('sftp_delete', { alias, path, isDir });
}

/** Rename/move a remote entry. */
export async function sftpRename(alias: string, from: string, to: string): Promise<void> {
  await invoke('sftp_rename', { alias, from, to });
}

/** Create a remote directory. */
export async function sftpMkdir(alias: string, path: string): Promise<void> {
  await invoke('sftp_mkdir', { alias, path });
}
