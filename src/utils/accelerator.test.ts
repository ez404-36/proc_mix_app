import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAcceleratorFromEvent,
  formatAccelerator,
} from "./accelerator";

/**
 * Override navigator.userAgent for a single test (jsdom permits redefining
 * the property via Object.defineProperty).
 */
function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

const NON_MAC_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";

interface PartialKeyEvent {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function makeEvent(e: PartialKeyEvent) {
  return {
    key: e.key,
    code: e.code ?? "",
    ctrlKey: e.ctrlKey ?? false,
    metaKey: e.metaKey ?? false,
    altKey: e.altKey ?? false,
    shiftKey: e.shiftKey ?? false,
  };
}

afterEach(() => {
  // Restore non-mac UA after each test so other suites see a stable default.
  setUserAgent(NON_MAC_UA);
  vi.restoreAllMocks();
});

describe("formatAccelerator", () => {
  it("should return an empty array for an empty accelerator string", () => {
    expect(formatAccelerator("")).toEqual([]);
  });

  it("should format CommandOrControl as 'Ctrl' on non-mac platforms", () => {
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("CommandOrControl+Shift+P")).toEqual([
      "Ctrl",
      "Shift",
      "P",
    ]);
  });

  it("should format CmdOrCtrl as Ctrl on non-mac platforms", () => {
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("CmdOrCtrl+S")).toEqual(["Ctrl", "S"]);
  });

  it("should format CommandOrControl as '⌘' on mac platforms", () => {
    setUserAgent(MAC_UA);
    expect(formatAccelerator("CommandOrControl+Shift+P")).toEqual([
      "⌘",
      "⇧",
      "P",
    ]);
  });

  it("should format Meta/Command/Super as 'Win' on non-mac, '⌘' on mac", () => {
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("Meta+A")).toEqual(["Win", "A"]);
    expect(formatAccelerator("Command+B")).toEqual(["Win", "B"]);
    expect(formatAccelerator("Cmd+C")).toEqual(["Win", "C"]);
    expect(formatAccelerator("Super+D")).toEqual(["Win", "D"]);

    setUserAgent(MAC_UA);
    expect(formatAccelerator("Meta+A")).toEqual(["⌘", "A"]);
    expect(formatAccelerator("Command+B")).toEqual(["⌘", "B"]);
  });

  it("should format Control and Ctrl as 'Ctrl' on any platform", () => {
    setUserAgent(MAC_UA);
    expect(formatAccelerator("Control+X")).toEqual(["Ctrl", "X"]);
    expect(formatAccelerator("Ctrl+Y")).toEqual(["Ctrl", "Y"]);
  });

  it("should format Alt/Option as '⌥' on mac and 'Alt' on non-mac", () => {
    setUserAgent(MAC_UA);
    expect(formatAccelerator("Alt+Z")).toEqual(["⌥", "Z"]);
    expect(formatAccelerator("Option+Z")).toEqual(["⌥", "Z"]);
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("Alt+Z")).toEqual(["Alt", "Z"]);
    expect(formatAccelerator("Option+Z")).toEqual(["Alt", "Z"]);
  });

  it("should uppercase unknown single-character key parts", () => {
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("Ctrl+a")).toEqual(["Ctrl", "A"]);
  });

  it("should uppercase unknown multi-character key parts (fallback path)", () => {
    setUserAgent(NON_MAC_UA);
    // "F5" is multi-character; default branch uppercases it.
    expect(formatAccelerator("Ctrl+F5")).toEqual(["Ctrl", "F5"]);
    // Unknown token also falls through to default.
    expect(formatAccelerator("Ctrl+enter")).toEqual(["Ctrl", "ENTER"]);
  });

  it("should trim whitespace around accelerator parts", () => {
    setUserAgent(NON_MAC_UA);
    expect(formatAccelerator("Ctrl + Shift + P")).toEqual([
      "Ctrl",
      "Shift",
      "P",
    ]);
  });

  it("should default to non-mac when navigator is undefined", () => {
    // Temporarily delete the global navigator reference and assert non-mac
    // behavior is selected (Ctrl, not ⌘).
    const original = globalThis.navigator;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).navigator;
    try {
      expect(formatAccelerator("CommandOrControl+P")).toEqual(["Ctrl", "P"]);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("buildAcceleratorFromEvent", () => {
  it("should return null when no main key is present (event.key is empty)", () => {
    expect(buildAcceleratorFromEvent(makeEvent({ key: "" }))).toBeNull();
  });

  it("should return null when only modifier keys are pressed", () => {
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Shift" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Control" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Meta" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Alt" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Option" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Cmd" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Command" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "Ctrl" }))).toBeNull();
  });

  it("should return null when no modifier is pressed", () => {
    expect(buildAcceleratorFromEvent(makeEvent({ key: "a" }))).toBeNull();
    expect(buildAcceleratorFromEvent(makeEvent({ key: "F5" }))).toBeNull();
  });

  it("should build a CommandOrControl combo when ctrlKey is pressed", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "p", ctrlKey: true })),
    ).toBe("CommandOrControl+P");
  });

  it("should build a CommandOrControl combo when metaKey is pressed", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "p", metaKey: true })),
    ).toBe("CommandOrControl+P");
  });

  it("should order modifiers as CommandOrControl, Alt, Shift", () => {
    const result = buildAcceleratorFromEvent(
      makeEvent({
        key: "k",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
    );
    expect(result).toBe("CommandOrControl+Alt+Shift+K");
  });

  it("should support Alt-only combos", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "p", altKey: true })),
    ).toBe("Alt+P");
  });

  it("should support Shift-only combos", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "p", shiftKey: true })),
    ).toBe("Shift+P");
  });

  it("should accept digits as main keys", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "1", ctrlKey: true })),
    ).toBe("CommandOrControl+1");
  });

  it("should accept function keys F1-F24 as main keys", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "F1", ctrlKey: true })),
    ).toBe("CommandOrControl+F1");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "F12", ctrlKey: true })),
    ).toBe("CommandOrControl+F12");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "F24", ctrlKey: true })),
    ).toBe("CommandOrControl+F24");
  });

  it("should not accept F25 or higher as a function key", () => {
    // F25 is multi-char but does not match the F1-F24 regex; also doesn't
    // match the named map, so it returns null and the whole combo is null.
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "F25", ctrlKey: true })),
    ).toBeNull();
  });

  it("should map arrow key names to Tauri names", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "ArrowUp", ctrlKey: true })),
    ).toBe("CommandOrControl+Up");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "ArrowDown", ctrlKey: true })),
    ).toBe("CommandOrControl+Down");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "ArrowLeft", ctrlKey: true })),
    ).toBe("CommandOrControl+Left");
    expect(
      buildAcceleratorFromEvent(
        makeEvent({ key: "ArrowRight", ctrlKey: true }),
      ),
    ).toBe("CommandOrControl+Right");
  });

  it("should map space and named keys via the named map", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: " ", ctrlKey: true })),
    ).toBe("CommandOrControl+Space");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Spacebar", ctrlKey: true })),
    ).toBe("CommandOrControl+Space");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Enter", ctrlKey: true })),
    ).toBe("CommandOrControl+Enter");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Tab", ctrlKey: true })),
    ).toBe("CommandOrControl+Tab");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Backspace", ctrlKey: true })),
    ).toBe("CommandOrControl+Backspace");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Delete", ctrlKey: true })),
    ).toBe("CommandOrControl+Delete");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Home", ctrlKey: true })),
    ).toBe("CommandOrControl+Home");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "End", ctrlKey: true })),
    ).toBe("CommandOrControl+End");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "PageUp", ctrlKey: true })),
    ).toBe("CommandOrControl+PageUp");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "PageDown", ctrlKey: true })),
    ).toBe("CommandOrControl+PageDown");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Insert", ctrlKey: true })),
    ).toBe("CommandOrControl+Insert");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Escape", ctrlKey: true })),
    ).toBe("CommandOrControl+Escape");
  });

  it("should accept symbol keys (single non-alphanumeric character)", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "/", ctrlKey: true })),
    ).toBe("CommandOrControl+/");
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "[", ctrlKey: true })),
    ).toBe("CommandOrControl+[");
  });

  it("should return null for unrecognized multi-character keys", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "Unknown", ctrlKey: true })),
    ).toBeNull();
  });

  it("should uppercase lowercase letters in the main key", () => {
    expect(
      buildAcceleratorFromEvent(makeEvent({ key: "z", ctrlKey: true })),
    ).toBe("CommandOrControl+Z");
  });
});
