// Typed wrappers around the terminal-layout ("макеты терминала") Tauri
// commands.
//
// `invoke` is confined to this service layer (project convention): stores and
// components call these functions, never `invoke` directly. Each function
// maps 1:1 to a `#[tauri::command]` in `src-tauri/src/commands/terminal_layouts.rs`.

import { invoke } from "@tauri-apps/api/core";
import type {
  SaveTerminalLayoutRequest,
  TerminalLayoutDto,
} from "../types/terminalLayout";

/** List every saved layout, name-ordered (the header dropdown's order). */
export async function listTerminalLayouts(): Promise<TerminalLayoutDto[]> {
  return invoke<TerminalLayoutDto[]>("list_terminal_layouts");
}

/**
 * Create a layout (when `request.id` is absent) or overwrite the existing
 * one. Returns the saved record (with the generated id / fresh timestamps).
 * Rejects with an error message when the name is empty or already taken.
 */
export async function saveTerminalLayout(
  request: SaveTerminalLayoutRequest,
): Promise<TerminalLayoutDto> {
  return invoke<TerminalLayoutDto>("save_terminal_layout", { request });
}

/** Rename a layout (keeps its snapshot; bumps `updatedAt`). */
export async function renameTerminalLayout(
  id: string,
  name: string,
): Promise<TerminalLayoutDto> {
  return invoke<TerminalLayoutDto>("rename_terminal_layout", { id, name });
}

/** Delete a layout. Idempotent — a missing id is not an error. */
export async function deleteTerminalLayout(id: string): Promise<void> {
  await invoke("delete_terminal_layout", { id });
}
