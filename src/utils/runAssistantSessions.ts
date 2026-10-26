// In-memory per-run assistant sessions.
//
// A run's chat and sidebar placement survive switching between console runs
// and expanding/collapsing the sidebar. Sessions are intentionally not
// persisted across app reloads; callers prune scopes when executions are
// cleared.

import type { AssistantChatMessage } from "../types/assistant";

export interface RunAssistantSession {
  messages: AssistantChatMessage[];
  isExpanded: boolean;
  width: number | null;
}

const EMPTY_SESSION: RunAssistantSession = {
  messages: [],
  isExpanded: false,
  width: null,
};

const sessions = new Map<string, RunAssistantSession>();

export function loadRunAssistantSession(
  sessionKey: string,
): RunAssistantSession {
  return sessions.get(sessionKey) ?? EMPTY_SESSION;
}

export function saveRunAssistantSession(
  sessionKey: string,
  session: RunAssistantSession,
): void {
  sessions.set(sessionKey, session);
}

export function clearRunAssistantSession(sessionKey: string): void {
  sessions.set(sessionKey, EMPTY_SESSION);
}

/** Removes cached `prefix:<id>` sessions whose id no longer exists. */
export function pruneRunAssistantSessions(
  prefix: string,
  validIds: ReadonlySet<string>,
): void {
  const prefixWithColon = `${prefix}:`;
  for (const sessionKey of sessions.keys()) {
    if (!sessionKey.startsWith(prefixWithColon)) continue;
    const id = sessionKey.slice(prefixWithColon.length);
    if (!validIds.has(id)) sessions.delete(sessionKey);
  }
}
