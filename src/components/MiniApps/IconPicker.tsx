import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { renderIcon } from "../../utils/iconRenderer";

/**
 * Curated, deduplicated set of common control-panel emojis offered in the
 * picker grid. Plain text characters (never inline `<svg>`): the webview
 * renders the platform emoji font, and the chosen character is stored verbatim
 * in `MiniApp.icon`.
 */
const EMOJI_SET: readonly string[] = [
  "🔌", "⚡", "⚙️", "🛠️", "📡", "🌐", "🔒", "🔓", "🔑",
  "🖥️", "💻", "📱", "📂", "📁", "📄", "📊", "🔍", "📋",
  "✅", "❌", "⚠️", "🔴", "🟢", "🟡", "🔵", "⬆️", "⬇️",
  "🔄", "🔁", "▶️", "⏸️", "⏹️", "⏰", "🔔", "📍", "🎯",
  "🚀", "🔥", "💾", "📦", "🏷️", "🎨", "🔧", "🔨", "🧩",
  "📶", "🛡️", "🔐", "💀", "🤖", "🧠", "💡", "🌙", "☀️",
  "⛅", "🌡️", "💧", "💨", "🌱", "🌲", "🏔️", "🌊", "🏠",
  "🏢", "🏗️", "🚦", "🚗", "✈️", "🚂", "⭐", "❤️",
];

/** Hard cap on an uploaded icon's size in bytes. Icons must stay tiny. */
const MAX_ICON_BYTES = 50 * 1024;

/** Convert raw file bytes into a `data:<mime>;base64,...` URI. Deterministic:
 *  the MIME comes from the extension, not the (often empty) blob type. */
function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Map a file name to its accepted MIME, or `null` if it isn't SVG/PNG. */
function mimeForName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  return null;
}

export interface IconPickerProps {
  value: string | undefined;
  onChange: (icon: string | undefined) => void;
}

/**
 * Reusable mini-app icon selector.
 *
 * Offers three affordances over the shared `MiniApp.icon` field:
 * - **Emoji** — toggles an inline grid of curated characters; clicking one
 *   commits it (stored verbatim) and closes the grid.
 * - **Upload** — opens the platform file dialog filtered to SVG/PNG; the file
 *   is read, size/type-checked (≤50KB, SVG/PNG only), and stored as a base64
 *   `data:` URI.
 * - **Clear** — clears the icon (`undefined`).
 *
 * The emoji grid closes on outside pointer-down or Escape. The `@tauri-apps`
 * dialog/fs plugins are not a dependency here, so the upload uses a standard
 * hidden `<input type="file">`, which the Tauri webview maps to the native
 * dialog. The `icon` field's own format (emoji vs `data:` URI) is what
 * {@link renderIcon} switches on; this component does not need to know which.
 */
export function IconPicker({ value, onChange }: IconPickerProps): ReactElement {
  const { t } = useTranslation();
  const [emojiOpen, setEmojiOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the emoji grid on an outside pointer-down or Escape while it is open.
  useEffect(() => {
    if (!emojiOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      const node = wrapRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        setEmojiOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setEmojiOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [emojiOpen]);

  const handleEmojiPick = useCallback(
    (emoji: string): void => {
      onChange(emoji);
      setEmojiOpen(false);
    },
    [onChange],
  );

  const handleClear = useCallback((): void => {
    onChange(undefined);
    setEmojiOpen(false);
  }, [onChange]);

  const handleUploadClick = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      // Reset so the same file can be re-selected, and so a rejected pick can
      // be retried without changing inputs.
      event.target.value = "";
      if (file === undefined) return;

      const mime = mimeForName(file.name);
      if (mime === null) {
        Message.error(t("miniapps.editor.iconPicker.invalidType"));
        return;
      }
      if (file.size > MAX_ICON_BYTES) {
        Message.error(t("miniapps.editor.iconPicker.tooLarge"));
        return;
      }

      void file
        .arrayBuffer()
        .then((buf: ArrayBuffer): void => {
          onChange(bytesToDataUri(new Uint8Array(buf), mime));
        })
        .catch((err: unknown): void => {
          // Reading the file should not fail in practice, but surface the
          // error rather than swallow it.
          const message = err instanceof Error ? err.message : String(err);
          Message.error(message);
        });
    },
    [onChange, t],
  );

  return (
    <div className="icon-picker" ref={wrapRef}>
      <div className="icon-picker__row">
        <span className="icon-picker__preview">
          {value ? (
            renderIcon(value, 24)
          ) : (
            <span className="icon-picker__placeholder" aria-hidden="true">
              ✦
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setEmojiOpen((open) => !open)}
          aria-expanded={emojiOpen}
        >
          {t("miniapps.editor.iconPicker.emoji")}
        </button>
        <button type="button" className="btn btn--ghost" onClick={handleUploadClick}>
          {t("miniapps.editor.iconPicker.upload")}
        </button>
        {value ? (
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={handleClear}
            aria-label={t("miniapps.editor.iconPicker.clear")}
            title={t("miniapps.editor.iconPicker.clear")}
          >
            ×
          </button>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,.png,image/svg+xml,image/png"
          className="icon-picker__file-input"
          onChange={handleFileChange}
        />
      </div>
      {emojiOpen ? (
        // A grid of ordinary buttons, NOT a `listbox`: an ARIA listbox
        // requires `option`-role children, and a `<button>` child is invalid.
        // `role="group"` is honest about what this is and keeps every entry
        // natively keyboard-reachable (Tab / Enter / Space).
        <div
          className="icon-picker__emoji-grid"
          role="group"
          aria-label={t("miniapps.editor.iconPicker.emoji")}
        >
          {EMOJI_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`icon-picker__emoji-btn${
                value === emoji ? " is-selected" : ""
              }`}
              aria-pressed={value === emoji}
              onClick={() => handleEmojiPick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
