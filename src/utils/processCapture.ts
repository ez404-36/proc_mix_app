// IPC wrappers + event subscription for Process Capture (the background
// "command recorder"). See `docs/process-capture.md`.
//
// The Rust side (`platform::process_watch`) exposes three commands and
// emits `CaptureEvent`s on the `capture-event` channel. This module is the
// single boundary the UI uses — components never call `invoke`/`listen`
// directly.
//
// IMPORTANT: callers must NOT invoke `startProcessCapture` until the user
// has granted consent (`resolveCaptureConsent`). Capture is opt-in; this
// module is the transport, not the gate.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureEvent } from "../types/capture";

/** Channel name — must match `CAPTURE_EVENT` in `process_watch.rs`. */
const CAPTURE_EVENT = "capture-event";

/**
 * Sentinel error returned by `start_process_capture` on platforms without
 * an implementation. Must match `CAPTURE_UNSUPPORTED` in
 * `process_watch.rs`. Callers use {@link isCaptureUnsupportedError} to hide
 * the feature rather than surfacing a scary error.
 */
export const CAPTURE_UNSUPPORTED = "CAPTURE_UNSUPPORTED";

/** Strict-equality check for the unsupported sentinel. */
export function isCaptureUnsupportedError(err: unknown): boolean {
  return err === CAPTURE_UNSUPPORTED;
}

/**
 * Start the background capture session. Resolves once the Rust side has the
 * session running. Rejects with {@link CAPTURE_UNSUPPORTED} off Windows.
 *
 * Idempotent on the Rust side: starting while already running is a no-op.
 */
export async function startProcessCapture(): Promise<void> {
  await invoke("start_process_capture");
}

/** Stop the capture session. Idempotent. */
export async function stopProcessCapture(): Promise<void> {
  await invoke("stop_process_capture");
}

/** Whether a capture session is currently running on the Rust side. */
export async function processCaptureStatus(): Promise<boolean> {
  return invoke<boolean>("process_capture_status");
}

// ---------------------------------------------------------------------------
// Event subscription. One global `listen()` is started the first time anyone
// subscribes; handlers register into a shared Set so the Tauri-side listener
// is created exactly once. This mirrors `subscribeExecutionEvents` in
// `utils/executor.ts`, including the synchronous unsubscribe return that
// avoids the StrictMode double-invoke race (a Promise-delivered unsub could
// delete the only Set entry after a later effect re-adds it).
// ---------------------------------------------------------------------------

let unlistenPromise: Promise<UnlistenFn> | null = null;
const handlers = new Set<(e: CaptureEvent) => void>();

function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) return unlistenPromise;
  unlistenPromise = listen<CaptureEvent>(CAPTURE_EVENT, (event) => {
    for (const h of handlers) h(event.payload);
  });
  unlistenPromise.catch((err) => {
    console.error("capture-event listener failed to attach:", err);
  });
  return unlistenPromise;
}

/**
 * Register a handler for capture events. Returns the unsubscribe function
 * synchronously — the handler is added to the in-memory Set immediately, and
 * the global Tauri listener is started lazily on first subscribe.
 *
 * Unlike the execution bridge, we do NOT auto-subscribe at module load: the
 * listener attaches only when the Recorder mounts, so a session that never
 * opens the recorder pays nothing.
 */
export function subscribeCaptureEvents(
  handler: (e: CaptureEvent) => void,
): () => void {
  handlers.add(handler);
  void ensureSubscribed();
  return () => {
    handlers.delete(handler);
  };
}

/** Resolves once the global capture-event listener is live on the Rust side. */
export async function awaitCaptureBridgeReady(): Promise<void> {
  await ensureSubscribed();
}
