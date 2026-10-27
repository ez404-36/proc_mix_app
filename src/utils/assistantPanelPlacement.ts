// In-memory sidebar placement for object-editing assistants. Placement
// survives closing an editor and switching between objects until app exit.

export interface AssistantPanelPlacement {
  isExpanded: boolean;
  width: number | null;
}

const EMPTY: AssistantPanelPlacement = {
  isExpanded: false,
  width: null,
};

const placements = new Map<string, AssistantPanelPlacement>();

export function loadPanelPlacement(
  sessionKey: string,
): AssistantPanelPlacement {
  return placements.get(sessionKey) ?? EMPTY;
}

export function savePanelPlacement(
  sessionKey: string,
  placement: AssistantPanelPlacement,
): void {
  placements.set(sessionKey, placement);
}
