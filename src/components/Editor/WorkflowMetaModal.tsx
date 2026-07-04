import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { normalizeTags } from "../../utils/commandFilters";
import { isValidApiSlug, sanitizeApiSlugInput } from "../../utils/apiSlug";
import { CancelIcon, CheckIcon } from "../icons";
import { IdBadge } from "../IdBadge";
import { ToggleSwitch } from "../ToggleSwitch";
import { SoundConfigEditor } from "../SoundConfigEditor";
import { useSoundStore } from "../../stores/soundStore";
import type { EntitySoundConfig } from "../../types";

/**
 * Editable workflow metadata, distinct from the persisted `Workflow` (no id,
 * timestamps, nodes, or edges — those are owned by the canvas / store). The
 * canvas merges this back into the graph on save.
 */
export interface WorkflowMeta {
  name: string;
  description?: string;
  tags: string[];
  categoryId?: string;
  icon?: string;
  /** Whether this workflow may be run over the built-in HTTP API. */
  apiEnabled?: boolean;
  /** Optional HTTP-API slug (`undefined` = no slug). */
  apiSlug?: string;
  /**
   * Optional per-workflow sound-notification override (`undefined` = inherit
   * the global sound settings for both outcomes).
   */
  sound?: EntitySoundConfig;
}

interface WorkflowMetaModalProps {
  initial: WorkflowMeta;
  /**
   * The workflow's id, shown (with a copy button) under the modal title so the
   * user can grab it for the HTTP API. `undefined` for a brand-new workflow
   * that has not been persisted yet (no id to show).
   */
  workflowId?: string;
  /**
   * Tag suggestions shown in the autocomplete list as the user types — the
   * SHARED base of tags used across both commands and workflows, so the
   * field mirrors the command form's tags editor.
   */
  tagSuggestions?: ReadonlyArray<string>;
  /**
   * API slugs already used by OTHER workflows, for a per-type uniqueness check
   * on the slug field. The current workflow's own slug is excluded by the
   * caller so re-saving with the same slug is allowed.
   */
  existingApiSlugs?: ReadonlyArray<string>;
  onSave: (meta: WorkflowMeta) => void;
  onClose: () => void;
}

/**
 * Modal collecting a workflow's name (required), description, and tags before
 * the first save. Mirrors `CommandForm`'s modal mechanics: Esc / backdrop
 * cancels, Cmd/Ctrl+Enter saves, focus lands on the name field. Save is
 * blocked until a non-empty name is entered.
 *
 * The Tags field mirrors the command form: chips with a remove button, an
 * inline input with autocomplete suggestions (filtered from
 * {@link WorkflowMetaModalProps.tagSuggestions}), and the same keyboard
 * affordances (ArrowUp/Down to cycle, Enter/`,` to commit, Backspace to
 * remove the last chip, Escape to clear the draft).
 */
export function WorkflowMetaModal({
  initial,
  workflowId,
  tagSuggestions = [],
  existingApiSlugs = [],
  onSave,
  onClose,
}: WorkflowMetaModalProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [tags, setTags] = useState<string[]>(() =>
    normalizeTags(initial.tags),
  );
  const [apiEnabled, setApiEnabled] = useState(initial.apiEnabled ?? false);
  const [apiSlug, setApiSlug] = useState(initial.apiSlug ?? "");
  const [sound, setSound] = useState<EntitySoundConfig | undefined>(
    initial.sound,
  );
  const [tagDraft, setTagDraft] = useState<string>("");

  // Sound picker data (built-ins + custom uploads) + preview + global defaults.
  const sounds = useSoundStore((s) => s.sounds);
  const preview = useSoundStore((s) => s.preview);
  const soundSettings = useSoundStore((s) => s.settings);
  const loadSounds = useSoundStore((s) => s.load);
  useEffect(() => {
    if (sounds.length === 0) {
      void loadSounds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [tagSuggestActiveIndex, setTagSuggestActiveIndex] =
    useState<number>(-1);
  const [showError, setShowError] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
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

  // Slug validity: only when API access is ON (the field is hidden otherwise,
  // so a validation error would be invisible) and a slug is entered (blank is
  // allowed = no slug). Otherwise it must match the character set AND not
  // collide with another workflow's slug.
  const trimmedSlug = apiSlug.trim();
  const slugError = ((): string | undefined => {
    if (!apiEnabled || trimmedSlug === "") return undefined;
    if (!isValidApiSlug(trimmedSlug)) {
      return t("editor.meta.httpApi.slugInvalid");
    }
    if (existingApiSlugs.includes(trimmedSlug)) {
      return t("editor.meta.httpApi.slugConflict");
    }
    return undefined;
  })();

  const handleSave = (): void => {
    if (nameInvalid || slugError !== undefined) {
      setShowError(true);
      return;
    }
    const trimmedDesc = description.trim();
    // Fold any uncommitted draft into the saved tags so a typed-but-not-
    // Entered tag is not silently dropped.
    const pending = tagDraft.trim();
    const finalTags = normalizeTags(
      pending === "" ? tags : [...tags, pending],
    );
    onSave({
      name: trimmedName,
      description: trimmedDesc === "" ? undefined : trimmedDesc,
      tags: finalTags,
      categoryId: initial.categoryId,
      icon: initial.icon,
      apiEnabled,
      apiSlug: trimmedSlug === "" ? undefined : trimmedSlug,
      sound,
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
        aria-label={t("editor.meta.title")}
      >
        <h2 className="command-form__title">{t("editor.meta.title")}</h2>
        {workflowId !== undefined ? <IdBadge id={workflowId} /> : null}

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="wf-meta-name">
            {t("editor.meta.name")}
          </label>
          <input
            ref={nameRef}
            id="wf-meta-name"
            className="input"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setName(e.target.value)
            }
          />
          {showError && nameInvalid ? (
            <p className="command-form__error">{t("editor.meta.nameRequired")}</p>
          ) : null}
        </div>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="wf-meta-desc">
            {t("editor.meta.description")}
          </label>
          <input
            id="wf-meta-desc"
            className="input"
            value={description}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setDescription(e.target.value)
            }
          />
        </div>

        <div className="command-form__field">
          <span className="command-form__label">{t("editor.meta.tags")}</span>
          <div className="tag-input-wrap">
            <div className="tag-input">
              {tags.map((tag, index) => (
                <span key={tag} className="tag-input__chip">
                  <span className="tag-input__chip-label">{tag}</span>
                  <button
                    type="button"
                    className="tag-input__chip-remove"
                    onClick={() => handleRemoveTag(index)}
                    aria-label={t("commandForm.tags.remove", { tag })}
                    title={t("commandForm.tags.remove", { tag })}
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
                placeholder={t("editor.meta.tagsPlaceholder")}
                autoComplete="off"
              />
            </div>
            {filteredTagSuggestions.length > 0 ? (
              <ul className="tag-suggest" role="listbox">
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
        </div>

        <div className="command-form__field command-form__field--inline">
          <ToggleSwitch
            checked={apiEnabled}
            onChange={setApiEnabled}
            ariaLabel={t("editor.meta.httpApi.enabled")}
          />
          <span>{t("editor.meta.httpApi.enabled")}</span>
        </div>

        {/* The slug only matters when API access is on, so hide it until the
            user opts in. */}
        {apiEnabled ? (
          <div className="command-form__field">
            <label className="command-form__label" htmlFor="wf-meta-api-slug">
              {t("editor.meta.httpApi.slug")}
            </label>
            <input
              id="wf-meta-api-slug"
              className={`input${
                showError && slugError !== undefined ? " input--error" : ""
              }`}
              value={apiSlug}
              onChange={(e) => setApiSlug(sanitizeApiSlugInput(e.target.value))}
              placeholder={t("editor.meta.httpApi.slugPlaceholder")}
              aria-invalid={
                showError && slugError !== undefined ? true : undefined
              }
            />
            {showError && slugError !== undefined ? (
              <p className="command-form__error">{slugError}</p>
            ) : null}
          </div>
        ) : null}

        <div className="command-form__field">
          <span className="command-form__label">
            {t("sound.workflowSectionLabel", {
              defaultValue: "Sound notifications",
            })}
          </span>
          <SoundConfigEditor
            value={sound}
            onChange={setSound}
            sounds={sounds}
            onPreview={(id) => void preview(id)}
            globalDefaults={{
              successSoundId: soundSettings.successSoundId,
              errorSoundId: soundSettings.errorSoundId,
            }}
          />
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
