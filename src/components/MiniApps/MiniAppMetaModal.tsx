import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Platform } from "../../types/platform";
import { ALL_PLATFORMS, isPlatform as isPlatformValue } from "../../types/platform";
import {
  CATEGORY_NEW_SENTINEL,
  CATEGORY_NONE_SENTINEL,
} from "../CommandForm/formState";
import { CancelIcon, CheckIcon } from "../icons";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { IconPicker } from "./IconPicker";

/** Editable mini-app metadata surfaced by the Properties modal. Distinct from
 *  the persisted `MiniApp` (no id, widgets, timestamps, run stats — those are
 *  owned by the canvas / store). The editor merges this back into the draft
 *  on save. */
export interface MiniAppMeta {
  name: string;
  description?: string;
  icon?: string;
  categoryId?: string;
  tags: string[];
  os?: Platform[];
}

interface MiniAppMetaModalProps {
  initial: MiniAppMeta;
  categorySuggestions: ReadonlyArray<string>;
  tagSuggestions: ReadonlyArray<string>;
  onSave: (meta: MiniAppMeta) => void;
  onClose: () => void;
}

/**
 * Modal collecting a mini-app's name (required), description, icon, category,
 * tags, and platform gating — everything that used to live in the always-on
 * "no widget selected" properties panel. Mirrors `WorkflowMetaModal`'s
 * mechanics exactly: backdrop/Cancel closes (Esc does not), Cmd/Ctrl+Enter
 * saves, Save is blocked while the name is empty.
 */
export function MiniAppMetaModal({
  initial,
  categorySuggestions,
  tagSuggestions,
  onSave,
  onClose,
}: MiniAppMetaModalProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [icon, setIcon] = useState(initial.icon);
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [os, setOs] = useState<Platform[] | undefined>(initial.os);
  const [tagDraft, setTagDraft] = useState<string>("");
  const [tagSuggestActiveIndex, setTagSuggestActiveIndex] = useState<number>(-1);
  const [showError, setShowError] = useState(false);

  // Category dropdown state. Mirrors the former `MetadataFields`: a
  // `__new__` sentinel flips the field into an inline text input for a
  // brand-new category name; `sessionCategories` accumulates names added
  // during this modal session so they appear in the dropdown immediately.
  const [addingCategory, setAddingCategory] = useState<boolean>(false);
  const [newCategoryDraft, setNewCategoryDraft] = useState<string>("");
  const [sessionCategories, setSessionCategories] = useState<string[]>([]);

  const categoryOptions: ReadonlyArray<DropdownOption> = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const consider = (raw: string): void => {
      const trimmed = raw.trim();
      if (trimmed === "") return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(trimmed);
    };
    for (const c of categorySuggestions) consider(c);
    for (const c of sessionCategories) consider(c);
    consider(categoryId ?? "");
    names.sort((a, b) => a.localeCompare(b));
    return [
      { value: CATEGORY_NONE_SENTINEL, label: t("miniapps.editor.categorySelect") },
      ...names.map((n) => ({ value: n, label: n })),
      { value: CATEGORY_NEW_SENTINEL, label: t("miniapps.editor.categoryNew") },
    ];
  }, [categorySuggestions, sessionCategories, categoryId, t]);

  const handleCategorySelect = useCallback((next: string): void => {
    if (next === CATEGORY_NEW_SENTINEL) {
      setNewCategoryDraft("");
      setAddingCategory(true);
      return;
    }
    setAddingCategory(false);
    // `CATEGORY_NONE_SENTINEL` ("") maps to "no category".
    setCategoryId(next === "" ? undefined : next);
  }, []);

  const handleCategoryAddConfirm = useCallback((): void => {
    const trimmed = newCategoryDraft.trim();
    setAddingCategory(false);
    setNewCategoryDraft("");
    if (trimmed === "") {
      setCategoryId(undefined);
      return;
    }
    setSessionCategories((prev) =>
      prev.some((c) => c.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setCategoryId(trimmed);
  }, [newCategoryDraft]);

  const handleCategoryAddCancel = useCallback((): void => {
    setAddingCategory(false);
    setNewCategoryDraft("");
  }, []);

  const filteredTagSuggestions = useMemo((): string[] => {
    const draft = tagDraft.trim();
    if (draft === "") return [];
    const lower = draft.toLowerCase();
    return tagSuggestions.filter(
      (s) =>
        s.toLowerCase().includes(lower) &&
        !tags.some((existing) => existing.toLowerCase() === s.toLowerCase()),
    );
  }, [tagDraft, tagSuggestions, tags]);

  useEffect(() => {
    setTagSuggestActiveIndex(-1);
  }, [filteredTagSuggestions]);

  const commitTag = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    setTags((prev) =>
      prev.some((tag) => tag.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setTagDraft("");
    setTagSuggestActiveIndex(-1);
  };

  const handleRemoveTag = (index: number): void => {
    setTags((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTagInputKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    const suggestions = filteredTagSuggestions;
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setTagSuggestActiveIndex((i) =>
        i + 1 >= suggestions.length ? 0 : i + 1,
      );
      return;
    }
    if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setTagSuggestActiveIndex((i) =>
        i - 1 < 0 ? suggestions.length - 1 : i - 1,
      );
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const active = suggestions[tagSuggestActiveIndex];
      commitTag(active ?? tagDraft);
      return;
    }
    if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
      e.preventDefault();
      handleRemoveTag(tags.length - 1);
      return;
    }
    if (e.key === "Escape") {
      // Clear the draft locally; do NOT close the modal here so a partial
      // tag entry is discarded without losing the rest of the form.
      if (tagDraft !== "") {
        e.preventDefault();
        e.stopPropagation();
        setTagDraft("");
        setTagSuggestActiveIndex(-1);
      }
    }
  };

  const trimmedName = name.trim();
  const nameInvalid = trimmedName === "";

  const handleSave = (): void => {
    if (nameInvalid) {
      setShowError(true);
      return;
    }
    const trimmedDesc = description.trim();
    // Fold any uncommitted draft into the saved tags so a typed-but-not-
    // Entered tag is not silently dropped.
    const pending = tagDraft.trim();
    const finalTags = pending === "" ? tags : [...tags, pending];
    onSave({
      name: trimmedName,
      description: trimmedDesc === "" ? undefined : trimmedDesc,
      icon,
      categoryId,
      tags: finalTags,
      os,
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Cmd/Ctrl+Enter saves. Escape intentionally does NOT close the modal —
    // it closes only via an explicit button or a backdrop click.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--meta"
        role="dialog"
        aria-modal="true"
        aria-label={t("miniapps.editor.properties")}
      >
        <h2 className="command-form__title">{t("miniapps.editor.properties")}</h2>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="ma-meta-name">
            {t("miniapps.editor.name")}
          </label>
          <input
            id="ma-meta-name"
            className={`input${showError && nameInvalid ? " input--error" : ""}`}
            value={name}
            aria-required="true"
            aria-invalid={showError && nameInvalid}
            placeholder={t("miniapps.editor.namePlaceholder")}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            autoFocus
          />
          {showError && nameInvalid ? (
            <p className="command-form__error">{t("miniapps.editor.nameRequired")}</p>
          ) : null}
        </div>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="ma-meta-desc">
            {t("miniapps.editor.description")}
          </label>
          <textarea
            id="ma-meta-desc"
            className="input"
            rows={2}
            value={description}
            placeholder={t("miniapps.editor.descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="command-form__field">
          <span className="command-form__label">{t("miniapps.editor.icon")}</span>
          <IconPicker value={icon} onChange={setIcon} />
        </div>

        <div className="command-form__field">
          <span className="command-form__label">
            {t("miniapps.editor.category.label")}
          </span>
          {addingCategory ? (
            // Inline "new category" editor: text input + confirm / cancel.
            // Enter confirms, Escape cancels (stopped from bubbling so the
            // modal's own Esc-does-not-close contract isn't affected).
            <div className="command-form__category-add">
              <input
                type="text"
                className="input command-form__category-add-input"
                value={newCategoryDraft}
                autoFocus
                onChange={(e) => setNewCategoryDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCategoryAddConfirm();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCategoryAddCancel();
                  }
                }}
                placeholder={t("miniapps.editor.category.addNewPlaceholder")}
                aria-label={t("miniapps.editor.category.addNewTitle")}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleCategoryAddConfirm}
              >
                {t("miniapps.editor.category.addNewConfirm")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleCategoryAddCancel}
              >
                {t("miniapps.editor.category.addNewCancel")}
              </button>
            </div>
          ) : (
            <Dropdown
              value={categoryId ?? ""}
              options={categoryOptions}
              onChange={handleCategorySelect}
              ariaLabel={t("miniapps.editor.category.label")}
            />
          )}
        </div>

        <div className="command-form__field">
          <span className="command-form__label">{t("miniapps.editor.tags")}</span>
          <div className="tag-input-wrap">
            <div className="tag-input">
              {tags.map((tag, index) => (
                <span key={tag} className="tag-input__chip">
                  <span className="tag-input__chip-label">{tag}</span>
                  <button
                    type="button"
                    className="tag-input__chip-remove"
                    onClick={() => handleRemoveTag(index)}
                    aria-label={t("miniapps.editor.tagsRemove", { tag })}
                    title={t("miniapps.editor.tagsRemove", { tag })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                className="tag-input__field"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={handleTagInputKeyDown}
                onBlur={() => {
                  if (tagSuggestActiveIndex >= 0) return;
                  commitTag(tagDraft);
                }}
                placeholder={t("miniapps.editor.tagsPlaceholder")}
                aria-label={t("miniapps.editor.tags")}
                autoComplete="off"
              />
            </div>
            {filteredTagSuggestions.length > 0 ? (
              <ul
                className="tag-suggest"
                role="listbox"
                aria-label={t("miniapps.editor.tags")}
              >
                {filteredTagSuggestions.map((suggestion, idx) => (
                  <li
                    key={suggestion}
                    className={
                      "tag-suggest__option" +
                      (idx === tagSuggestActiveIndex
                        ? " tag-suggest__option--active"
                        : "")
                    }
                    role="option"
                    aria-selected={idx === tagSuggestActiveIndex}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitTag(suggestion);
                    }}
                    onMouseEnter={() => setTagSuggestActiveIndex(idx)}
                  >
                    {suggestion}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <p className="form-hint">{t("miniapps.editor.tagsHint")}</p>
        </div>

        {/* Platform gating. An empty selection means "every platform". */}
        <div className="command-form__field">
          <span className="command-form__label">{t("miniapps.editor.os")}</span>
          <Dropdown
            multiple
            values={os ?? []}
            options={ALL_PLATFORMS.map((p) => ({
              value: p,
              label: t(`plugins.os.${p}`),
            }))}
            onChangeMultiple={(values) => {
              const platforms = values.filter(isPlatformValue);
              // Persist `undefined`, not `[]`, for "no restriction": an empty
              // array would round-trip as an explicit empty allow-list.
              setOs(platforms.length > 0 ? platforms : undefined);
            }}
            placeholder={t("miniapps.editor.osAny")}
            ariaLabel={t("miniapps.editor.os")}
            // Single-select props are unused in multi mode but required by
            // the shared component's signature.
            value=""
            onChange={() => {}}
          />
          <p className="form-hint">{t("miniapps.editor.osHint")}</p>
        </div>

        <div className="command-form__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--run command-form__action"
            onClick={handleSave}
          >
            <CheckIcon />
            {t("common.apply")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
