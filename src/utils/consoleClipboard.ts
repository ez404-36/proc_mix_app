import type { TFunction } from "i18next";
import type { ContextMenuEntry } from "../components/ContextMenu";

/**
 * Returns the text currently selected by the user, but only when that
 * selection lives entirely inside the given container. A selection that
 * starts outside the console body (e.g. in a script preview) must not be
 * treated as console text — the anchor/focus containment guards against
 * that. Returns "" when there is no in-container selection.
 */
export function getSelectionWithin(container: HTMLElement | null): string {
  if (!container) return "";
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }
  const text = selection.toString();
  if (text.length === 0) return "";
  if (
    !container.contains(selection.anchorNode) ||
    !container.contains(selection.focusNode)
  ) {
    return "";
  }
  return text;
}

/** Copy text to the clipboard, swallowing (and logging) any failure. */
export function copyText(text: string): void {
  if (text.length === 0) return;
  void navigator.clipboard.writeText(text).catch((err: unknown) => {
    console.warn("copy console text failed", err);
  });
}

/** Select the entire text content of a console body element. */
export function selectAllWithin(container: HTMLElement | null): void {
  if (!container) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Build the shared Copy / Copy all / Select all entries for a console
 * output body. `container` is the scrollable body element whose `innerText`
 * is the full console text. Used by both the global OutputPanel and the
 * inline live-run output in the command form.
 */
export function buildConsoleCopyMenu(
  container: HTMLElement | null,
  t: TFunction,
): ContextMenuEntry[] {
  const selected = getSelectionWithin(container);
  const allText = container?.innerText ?? "";
  const hasContent = allText.length > 0;

  return [
    {
      id: "copy",
      label: t("contextMenu.copy"),
      disabled: selected.length === 0,
      onSelect: () => copyText(selected),
    },
    {
      id: "copy-all",
      label: t("contextMenu.copyAll", { defaultValue: "Copy all" }),
      disabled: !hasContent,
      onSelect: () => copyText(allText),
    },
    { id: "div1", divider: true },
    {
      id: "select-all",
      label: t("contextMenu.selectAll"),
      disabled: !hasContent,
      onSelect: () => selectAllWithin(container),
    },
  ];
}
