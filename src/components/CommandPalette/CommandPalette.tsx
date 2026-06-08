import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import type { Command } from "../../types";
import {
  getCommandDescription,
  getCommandName,
} from "../../utils/commandLabels";
import { triggerCommandRun } from "../../services/commandRunner";

function matches(cmd: Command, query: string, t: TFunction): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  // Match against the LOCALIZED name so localized seed labels are findable.
  if (getCommandName(cmd, t).toLowerCase().includes(q)) return true;
  if (cmd.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

export function CommandPalette(): ReactElement | null {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.paletteOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const commands = useCommandStore((s) => s.commands);

  const [query, setQuery] = useState<string>("");
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(
    () => commands.filter((c) => matches(c, query, t)),
    [commands, query, t],
  );

  // Reset & focus on open
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    // Defer focus until the input is mounted.
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Keep activeIndex within bounds when results change.
  useEffect(() => {
    setActiveIndex((idx) => {
      if (filtered.length === 0) return 0;
      if (idx >= filtered.length) return filtered.length - 1;
      if (idx < 0) return 0;
      return idx;
    });
  }, [filtered.length]);

  if (!open) return null;

  const close = (): void => {
    setPaletteOpen(false);
  };

  const runItem = (cmd: Command): void => {
    void triggerCommandRun(cmd);
    close();
  };

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
    setActiveIndex(0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((idx) => (idx + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setActiveIndex((idx) => (idx - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) runItem(cmd);
    }
  };

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <div
      className="palette-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={t("commandPalette.ariaLabel")}
    >
      <div className="palette">
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          placeholder={t("commandPalette.placeholder")}
          value={query}
          onChange={handleSearchChange}
          onKeyDown={handleKeyDown}
        />
        {filtered.length === 0 ? (
          <div className="palette__empty">{t("commandPalette.empty")}</div>
        ) : (
          <div className="palette__list" role="listbox">
            {filtered.map((cmd, idx) => {
              const displayName = getCommandName(cmd, t);
              const displayDesc = getCommandDescription(cmd, t);
              return (
                <div
                  key={cmd.id}
                  role="option"
                  aria-selected={idx === activeIndex}
                  className={`palette__item${idx === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => runItem(cmd)}
                >
                  <div className="palette__item-title">{displayName}</div>
                  {displayDesc ? (
                    <div className="palette__item-desc">{displayDesc}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
