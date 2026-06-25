import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject,
} from "react";
import type { TFunction } from "i18next";

import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import { sanitizeApiSlugInput } from "../../utils/apiSlug";
import type { FormErrors, FormState, FormTab } from "./formState";

export interface MainTabProps {
  t: TFunction;
  active: boolean;
  form: FormState;
  errors: FormErrors;
  showErrors: boolean;
  nameInputRef: RefObject<HTMLInputElement | null>;
  onNameChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onDescriptionChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  // Tag chip editor.
  tagDraft: string;
  setTagDraft: (value: string) => void;
  filteredTagSuggestions: ReadonlyArray<string>;
  tagSuggestActiveIndex: number;
  setTagSuggestActiveIndex: (index: number) => void;
  onTagInputKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  commitTag: (raw: string) => void;
  onRemoveTag: (index: number) => void;
  // Category editor.
  addingCategory: boolean;
  newCategoryDraft: string;
  setNewCategoryDraft: (value: string) => void;
  categoryOptions: ReadonlyArray<DropdownOption>;
  onCategorySelect: (next: string) => void;
  onCategoryAddConfirm: () => void;
  onCategoryAddCancel: () => void;
  // HTTP API.
  onApiEnabledChange: (next: boolean) => void;
  onApiSlugChange: (next: string) => void;
}

/**
 * The command form's Main tab: metadata (name, description, tags,
 * category) plus the HTTP-API opt-in. Presentational — the parent
 * CommandForm owns all state and passes handlers down.
 */
export function MainTab(props: MainTabProps): ReactElement {
  const {
    t,
    active,
    form,
    errors,
    showErrors,
    nameInputRef,
    onNameChange,
    onDescriptionChange,
    tagDraft,
    setTagDraft,
    filteredTagSuggestions,
    tagSuggestActiveIndex,
    setTagSuggestActiveIndex,
    onTagInputKeyDown,
    commitTag,
    onRemoveTag,
    addingCategory,
    newCategoryDraft,
    setNewCategoryDraft,
    categoryOptions,
    onCategorySelect,
    onCategoryAddConfirm,
    onCategoryAddCancel,
    onApiEnabledChange,
    onApiSlugChange,
  } = props;

  const tab: FormTab = "main";
  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      <label className="command-form__field">
        <span className="command-form__label command-form__label--required">
          <span className="command-form__required" aria-hidden="true">
            *
          </span>
          {t("commandForm.fields.name")}
        </span>
        <input
          ref={nameInputRef}
          type="text"
          className="input"
          value={form.name}
          onChange={onNameChange}
          placeholder={t("commandForm.placeholders.name")}
          aria-required="true"
          aria-invalid={showErrors && errors.name ? true : undefined}
          aria-describedby={
            showErrors && errors.name ? "command-form-name-error" : undefined
          }
        />
        {showErrors && errors.name ? (
          <span
            id="command-form-name-error"
            className="command-form__error"
            role="alert"
          >
            {errors.name}
          </span>
        ) : null}
      </label>

      <label className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.description")}
        </span>
        <textarea
          className="input command-form__description"
          value={form.description}
          onChange={onDescriptionChange}
          placeholder={t("commandForm.placeholders.description")}
          rows={3}
        />
      </label>

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.tags")}
        </span>
        <div className="tag-input-wrap">
          <div className="tag-input">
            {form.tags.map((tag, index) => (
              <span key={tag} className="tag-input__chip">
                <span className="tag-input__chip-label">{tag}</span>
                <button
                  type="button"
                  className="tag-input__chip-remove"
                  onClick={() => onRemoveTag(index)}
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
              onKeyDown={onTagInputKeyDown}
              onBlur={() => {
                if (tagSuggestActiveIndex >= 0) return;
                commitTag(tagDraft);
              }}
              placeholder={t("commandForm.placeholders.tags")}
              aria-label={t("commandForm.fields.tags")}
              autoComplete="off"
            />
          </div>
          {filteredTagSuggestions.length > 0 ? (
            <ul
              className="tag-suggest"
              role="listbox"
              aria-label={t("commandForm.fields.tags")}
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
      </div>

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.category")}
        </span>
        {addingCategory ? (
          // Inline "new category" editor: a text input + confirm /
          // cancel. Enter confirms, Escape cancels (stopped from
          // bubbling so the modal's own Esc handler doesn't fire).
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
                  onCategoryAddConfirm();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCategoryAddCancel();
                }
              }}
              placeholder={t("commandForm.category.addNewPlaceholder")}
              aria-label={t("commandForm.category.addNewTitle")}
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={onCategoryAddConfirm}
            >
              {t("commandForm.category.addNewConfirm")}
            </button>
            <button type="button" className="btn" onClick={onCategoryAddCancel}>
              {t("commandForm.category.addNewCancel")}
            </button>
          </div>
        ) : (
          <Dropdown
            value={form.category}
            options={categoryOptions}
            onChange={onCategorySelect}
            ariaLabel={t("commandForm.fields.category")}
          />
        )}
      </div>

      {/* --- HTTP API: opt-in + slug for the built-in REST server --- */}
      <div className="command-form__field command-form__field--inline">
        <ToggleSwitch
          checked={form.apiEnabled}
          onChange={onApiEnabledChange}
          ariaLabel={t("commandForm.httpApi.enabled")}
        />
        <span>{t("commandForm.httpApi.enabled")}</span>
      </div>
      {/* The slug only matters when API access is on, so it's hidden until
          the user opts in (keeps the form tidy and the intent clear). */}
      {form.apiEnabled ? (
        <div className="command-form__field">
          <label className="command-form__label" htmlFor="command-form-api-slug">
            {t("commandForm.httpApi.slug")}
          </label>
          <input
            id="command-form-api-slug"
            className={`input${
              showErrors && errors.apiSlug ? " input--error" : ""
            }`}
            value={form.apiSlug}
            onChange={(e) => onApiSlugChange(sanitizeApiSlugInput(e.target.value))}
            placeholder={t("commandForm.httpApi.slugPlaceholder")}
            aria-invalid={showErrors && errors.apiSlug ? true : undefined}
          />
          {showErrors && errors.apiSlug ? (
            <p className="command-form__error">{errors.apiSlug}</p>
          ) : (
            <span className="command-form__hint" role="note">
              {t("commandForm.httpApi.slugHint", {
                slug:
                  form.apiSlug.trim() === "" ? "<slug>" : form.apiSlug.trim(),
              })}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
