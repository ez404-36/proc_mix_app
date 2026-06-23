/**
 * Types for the SFTP dual-pane file manager.
 *
 * The listing/entry shapes mirror the Rust DTOs in
 * `src-tauri/src/core/sftp/types.rs` character-for-character via serde's
 * `rename_all = "camelCase"`. The clipboard/drag shapes are frontend-only
 * (UI state for copy/cut/paste and drag-and-drop) and never cross IPC.
 *
 * Transport contract: every operation goes through `services/sftpService.ts`
 * (never `invoke` directly). The backend validates the destination alias and
 * every remote path before spawning `sftp`; a rejected value surfaces as an
 * error string carrying a sentinel prefix (see {@link SFTP_ERROR}).
 */

/** What a directory entry is. Mirrors `SftpEntryKind`. */
export type SftpEntryKind = 'file' | 'dir' | 'symlink';

/** A single entry in a remote directory listing. Mirrors `SftpEntry`. */
export interface SftpEntry {
  name: string;
  kind: SftpEntryKind;
  /** Size in bytes when known. */
  size: number | null;
  /** Raw `LC_ALL=C` `ls -l` date field(s), kept verbatim for display. */
  modified: string | null;
  /** Raw permission string (e.g. `drwxr-xr-x`) when parsed. */
  permissions: string | null;
}

/** A remote directory listing for one pane. Mirrors `SftpListing`. */
export interface SftpListing {
  path: string;
  entries: SftpEntry[];
}

/** A single entry in a local directory listing. Mirrors `LocalEntry`. */
export interface LocalEntry {
  name: string;
  kind: SftpEntryKind;
  size: number | null;
}

/** A local directory listing for the left pane. Mirrors `LocalListing`. */
export interface LocalListing {
  path: string;
  entries: LocalEntry[];
}

// ---------------------------------------------------------------------------
// Frontend-only UI state (never crosses IPC).
// ---------------------------------------------------------------------------

/** Which pane a path belongs to. The left pane is always the local machine. */
export type PaneSide = 'local' | 'remote';

/** Copy vs move semantics for a clipboard paste or a drag-and-drop. */
export type TransferMode = 'copy' | 'move';

/**
 * The clipboard for copy/cut/paste. `mode: 'move'` corresponds to "cut"
 * (the source is removed after a confirmed transfer). `paths` are absolute
 * paths on the `side` they came from.
 */
export interface ClipboardOp {
  mode: TransferMode;
  side: PaneSide;
  paths: string[];
}

/**
 * The payload carried by an in-progress drag. Mirrors {@link ClipboardOp}
 * minus the mode (the mode is decided at drop time by the modifier key).
 * Also serialised into the native `dataTransfer` under {@link DRAG_MIME}.
 */
export interface DragPayload {
  side: PaneSide;
  paths: string[];
}

/** Internal MIME type for in-app SFTP drags (not OS-file drops). */
export const DRAG_MIME = 'application/x-procmix-sftp';

/**
 * Error sentinel prefixes returned by the backend. Mirrors the Rust consts in
 * `core::sftp::types`. The service layer matches on these to localise toasts.
 */
export const SFTP_ERROR = {
  invalidTarget: 'INVALID_SFTP_TARGET',
  invalidPath: 'INVALID_REMOTE_PATH',
} as const;
