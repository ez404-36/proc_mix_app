const MODIFIER_ORDER = ["CommandOrControl", "Alt", "Shift"] as const;

const MODIFIER_KEYS = new Set([
  "Control",
  "Ctrl",
  "Meta",
  "Command",
  "Cmd",
  "Alt",
  "Option",
  "Shift",
]);

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated; userAgent is the recommended fallback.
  return /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent);
}

export function formatAccelerator(accel: string): string[] {
  if (!accel) return [];
  const isMac = isMacPlatform();
  return accel.split("+").map((part) => formatPart(part.trim(), isMac));
}

function formatPart(part: string, isMac: boolean): string {
  switch (part) {
    case "CommandOrControl":
    case "CmdOrCtrl":
      return isMac ? "⌘" : "Ctrl";
    case "Command":
    case "Cmd":
    case "Meta":
    case "Super":
      return isMac ? "⌘" : "Win";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
    case "Option":
      return isMac ? "⌥" : "Alt";
    case "Shift":
      return isMac ? "⇧" : "Shift";
    default:
      return part.toUpperCase();
  }
}

interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Build an accelerator string from a KeyboardEvent.
 * Returns null if the combo is invalid (no main key, or only modifiers, or
 * no modifier present).
 */
export function buildAcceleratorFromEvent(event: KeyEventLike): string | null {
  const mainKey = normalizeMainKey(event);
  if (mainKey === null) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) return null;

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  return [...ordered, mainKey].join("+");
}

function normalizeMainKey(event: KeyEventLike): string | null {
  const k = event.key;
  if (!k || MODIFIER_KEYS.has(k)) return null;

  // Named keys mapping to Tauri-recognized accelerators.
  // Checked first so that single-character keys like " " (space) map
  // correctly before falling through to the generic character branch.
  const namedMap: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    " ": "Space",
    Spacebar: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Escape: "Escape",
  };
  if (namedMap[k]) return namedMap[k];

  // Function keys: F1..F24
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k;

  // Single character (letter or digit)
  if (k.length === 1) {
    const c = k.toUpperCase();
    if (/^[A-Z0-9]$/.test(c)) return c;
    // Symbols like "/", "\\", "[", "]" – use as-is.
    return c;
  }

  return null;
}
