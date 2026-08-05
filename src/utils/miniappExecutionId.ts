// Tagging scheme for a Mini-App widget's execution id, used to route
// `execution-event` Tauri events to the ONE window that owns them.
//
// WHY THIS EXISTS (root cause, not a guard): Tauri's `execution-event`
// channel fans out to EVERY open webview by default (see the doc comment on
// `MiniAppWindowApp`). A mini-app runs in its own standalone OS window, but
// without a way to tell "this run belongs to mini-app X" apart from a
// library command run, `useExecutionBridge` in every OTHER open window
// (the main window, or a different mini-app's window) would also register
// the run in ITS OWN `executionStore` — leaking the mini-app's console
// output into the main window's global `OutputPanel`/History-live-view
// instead of keeping it inside the mini-app's own window.
//
// The Rust executor honours a caller-supplied `executionId` verbatim (see
// `core/executor/mod.rs`), so encoding the owning mini-app id directly in
// the id — rather than a side-channel lookup — is sufficient: no Rust
// change is needed. Mirrors the existing `ma-inline-<uuid>` prefixing
// convention for ephemeral inline commands (`makeInlineCommandId` in
// `utils/miniappInlineCommand.ts`).

const PREFIX = "mawin";
const SEPARATOR = ":";

/**
 * Mint a tagged execution id for a widget run belonging to mini-app
 * `miniAppId`: `mawin:<miniAppId>:<uuid>`. Passed as `RunOptions.executionId`
 * so the Rust executor's `started`/`stdout`/`stderr`/`finished`/… events all
 * carry this exact id back.
 */
export function makeMiniAppExecutionId(miniAppId: string): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return `${PREFIX}${SEPARATOR}${miniAppId}${SEPARATOR}${uuid}`;
}

/**
 * Parse an execution id minted by {@link makeMiniAppExecutionId}. Returns
 * `null` for any id that isn't a mini-app-tagged id (a plain library command
 * run, an inline-command ephemeral run, etc.) — those are untagged and
 * always routed normally.
 *
 * Splits on the FIRST two separators only, so a mini-app id itself
 * containing a `:` (not expected — mini-app ids are UUIDs — but not
 * guaranteed by the type system) does not truncate the parsed id.
 */
export function parseMiniAppExecutionId(
  id: string,
): { miniAppId: string } | null {
  if (!id.startsWith(`${PREFIX}${SEPARATOR}`)) return null;
  const rest = id.slice(PREFIX.length + SEPARATOR.length);
  const sepIdx = rest.indexOf(SEPARATOR);
  if (sepIdx <= 0) return null;
  const miniAppId = rest.slice(0, sepIdx);
  return { miniAppId };
}
