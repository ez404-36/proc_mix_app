import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type {
  ContextMenuEntry,
  ContextMenuItem,
} from "../components/ContextMenu";
import {
  buildConsoleCopyMenu,
  copyText,
  getSelectionWithin,
  selectAllWithin,
} from "./consoleClipboard";

/** Fake translator: echoes the key so labels are deterministic. */
const fakeT = ((key: string) => key) as unknown as TFunction;

/** Local narrowing guard — the barrel does not re-export `isDivider`. */
function isItem(entry: ContextMenuEntry): entry is ContextMenuItem {
  return !("divider" in entry);
}

let writeTextMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a container in the DOM with the given text and return it. jsdom does
 * not implement `innerText`, so it is defined explicitly to mirror the text —
 * `buildConsoleCopyMenu` reads `container.innerText` for the full console text.
 */
function makeContainer(text: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  Object.defineProperty(el, "innerText", {
    configurable: true,
    get: () => el.textContent ?? "",
  });
  document.body.appendChild(el);
  return el;
}

/** Select the full contents of the given element. */
function selectContents(el: Node): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("getSelectionWithin", () => {
  it("returns an empty string for a null container", () => {
    expect(getSelectionWithin(null)).toBe("");
  });

  it("returns an empty string when there is no active selection", () => {
    const container = makeContainer("hello");
    window.getSelection()?.removeAllRanges();

    expect(getSelectionWithin(container)).toBe("");
  });

  it("returns an empty string when the selection lies outside the container", () => {
    const container = makeContainer("inside text");
    const outside = makeContainer("outside text");
    selectContents(outside);

    expect(getSelectionWithin(container)).toBe("");
  });

  it("returns the selected text when the selection is inside the container", () => {
    const container = makeContainer("selected console line");
    selectContents(container);

    expect(getSelectionWithin(container)).toBe("selected console line");
  });
});

describe("copyText", () => {
  it("does nothing for empty text", () => {
    copyText("");

    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("writes non-empty text to the clipboard", () => {
    copyText("copy me");

    expect(writeTextMock).toHaveBeenCalledWith("copy me");
  });

  it("logs a warning when the clipboard write rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("denied");
    writeTextMock.mockRejectedValue(error);

    copyText("boom");
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith("copy console text failed", error);
    });
  });
});

describe("selectAllWithin", () => {
  it("does nothing for a null container", () => {
    const spy = vi.spyOn(document, "createRange");

    selectAllWithin(null);

    expect(spy).not.toHaveBeenCalled();
  });

  it("selects the full contents of the container", () => {
    const container = makeContainer("all of this text");

    selectAllWithin(container);

    const selection = window.getSelection();
    expect(selection?.toString()).toBe("all of this text");
  });
});

describe("buildConsoleCopyMenu", () => {
  it("disables copy/copy-all/select-all for an empty container", () => {
    const container = makeContainer("");
    window.getSelection()?.removeAllRanges();

    const entries = buildConsoleCopyMenu(container, fakeT);
    const items = entries.filter(isItem);

    expect(items.map((i) => i.id)).toEqual(["copy", "copy-all", "select-all"]);
    expect(items.every((i) => i.disabled)).toBe(true);
    expect(entries.some((e) => !isItem(e))).toBe(true);
  });

  it("enables entries when there is content and a selection", () => {
    const container = makeContainer("live output");
    selectContents(container);

    const entries = buildConsoleCopyMenu(container, fakeT);
    const byId = new Map(entries.filter(isItem).map((i) => [i.id, i]));

    expect(byId.get("copy")?.disabled).toBe(false);
    expect(byId.get("copy-all")?.disabled).toBe(false);
    expect(byId.get("select-all")?.disabled).toBe(false);
  });

  it("wires each onSelect to the matching clipboard/selection helper", () => {
    const container = makeContainer("wired text");
    selectContents(container);

    const entries = buildConsoleCopyMenu(container, fakeT);
    const byId = new Map(entries.filter(isItem).map((i) => [i.id, i]));

    byId.get("copy")?.onSelect?.();
    expect(writeTextMock).toHaveBeenLastCalledWith("wired text");

    byId.get("copy-all")?.onSelect?.();
    expect(writeTextMock).toHaveBeenLastCalledWith("wired text");

    window.getSelection()?.removeAllRanges();
    byId.get("select-all")?.onSelect?.();
    expect(window.getSelection()?.toString()).toBe("wired text");
  });
});
