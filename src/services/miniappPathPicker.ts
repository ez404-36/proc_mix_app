import { invoke } from "@tauri-apps/api/core";

/**
 * Open the native «open file» dialog (no type filter) for a Mini-App `path`
 * artifact and return the chosen ABSOLUTE path, or `null` when the user
 * cancels. The Rust side (`pick_artifact_path`) uses `rfd`, so the full
 * filesystem path survives — unlike a webview `<input type="file">`, which only
 * exposes the file NAME inside the Tauri webview.
 */
export async function pickArtifactPath(): Promise<string | null> {
  return invoke<string | null>("pick_artifact_path");
}
