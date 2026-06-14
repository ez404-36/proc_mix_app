import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  Command,
  OutputSchema,
  ParsedCli,
  Shell,
  VariableSpec,
} from "../../types";
import {
  createCommand as createCommandWithHistory,
  updateCommand as updateCommandWithHistory,
} from "../../services/commandActions";
import { detectAdminEscalation } from "../../utils/detectAdminEscalation";
import { getCachedPlatform } from "../../utils/platform";
import { getCachedAvailableShells } from "../../utils/shells";
import { normalizeTags } from "../../utils/commandFilters";
import { isOverridingSystem, isValidEnvVarName } from "../../utils/envVars";
import { parseUtilityNameWithRange } from "../../utils/utilityName";
import { useUtilityHelp } from "../../hooks/useUtilityHelp";
import { useAdminEscalation } from "../../hooks/useAdminEscalation";
import { useCommandLiveRun } from "../../hooks/useCommandLiveRun";
import { useUIStore } from "../../stores/uiStore";
import { CancelIcon, RunIcon, SaveIcon, TrashIcon } from "../icons";
import { HelpTooltip } from "../HelpTooltip";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { OutputSchemaEditor } from "./OutputSchemaEditor";
import { ScriptEditor } from "./ScriptEditor";
import { LiveRunOutput } from "./LiveRunOutput";
import { FlagBuilder } from "./FlagBuilder";
import type {
  UtilityHighlight,
  UtilityHighlightStatus,
} from "./scriptHighlight";
import {
  buildInitialState,
  buildShellOptions,
  CATEGORY_NEW_SENTINEL,
  CATEGORY_NONE_SENTINEL,
  computeVariableErrors,
  envRowsToRecord,
  fingerprintForm,
  isShell,
  makeRowId,
  parseTimeoutSeconds,
  rowsToVariableSpecs,
  syncScriptDefaultsToRows,
  syncVariableDefaultToScript,
} from "./formState";
import type {
  EnvRow,
  FormErrors,
  FormState,
  FormTab,
  VariableRow,
} from "./formState";
import {
  getCachedProcessEnv,
  getProcessEnv,
} from "../../services/environmentService";
import { parseUtilityFlags } from "../../services/utilityHelp";
import { useEnvManagerStore } from "../../stores/envManagerStore";

export interface CommandFormProps {
  /**
   * The command to edit, or `null` in create mode. In edit mode a `null`
   * command short-circuits to render nothing (the target was not found).
   */
  command: Command | null;
  /** Discriminates between "create" and "edit" intent. */
  mode: "create" | "edit";
  /**
   * Called when the form is done and the host should leave (after a
   * successful save, or when the user hits Cancel). The host owns the
   * actual navigation. In-flight runs are torn down before this fires.
   */
  onClose: () => void;
  /**
   * Reports whether the form currently differs from its initial state.
   * The host (CommandEditor view) uses this to drive the unsaved-changes
   * confirmation when navigating away. Called on every dirtiness change
   * and reset to `false` on unmount.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Where a test run's output is shown:
   *   - `"embedded"` (default): the form's own inline `LiveRunOutput`
   *     panel. Preserves the original modal behavior.
   *   - `"global"`: the app-wide console (OutputPanel) via the execution
   *     store, exactly like running a command from the Library. No inline
   *     panel is rendered. Used by the full-screen `CommandEditor` so the
   *     editor relies on the global console.
   *
   * The embedded panel component is intentionally kept in the codebase for
   * both modes' sake — only the rendering is gated by this prop.
   */
  runTarget?: "embedded" | "global";
  /**
   * Category names already in use across the library, surfaced as
   * autocomplete suggestions in the Category field. Categories are
   * modeled inline (free-text on `categoryId`) — there is no separate
   * categories entity — so this list is simply derived from the current
   * commands by the caller. Optional; defaults to none.
   */
  categorySuggestions?: ReadonlyArray<string>;
  /**
   * Tags already used across the library, surfaced as suggestions in the
   * Tags field so users can pick existing ones rather than re-typing them.
   * Derived from all commands by the caller via `collectTags`. Optional;
   * defaults to none (free-text only).
   */
  tagSuggestions?: ReadonlyArray<string>;
  /**
   * Pre-filled script for create mode, supplied by the ScriptFirstCreator
   * flow. Ignored in edit mode. When set, the Script tab field is
   * populated on first render with this value so the user can refine it.
   */
  initialScript?: string;
}

/**
 * Full-screen form for creating and editing user commands.
 *
 * Behaviour:
 *   - Esc cancels
 *   - Backdrop click cancels
 *   - Cmd/Ctrl+Enter saves (when validation passes)
 *   - In create mode, label is "Create"; in edit mode, "Save"
 *   - Editing a seed command (one carrying `nameKey`) converts it into a
 *     regular user command: `nameKey`/`descriptionKey` are dropped and the
 *     literal `name`/`description` taken from the form (already populated
 *     with the localized values at open time) are persisted.
 *
 * Focus management uses a small in-component focus trap so Tab cycles
 * stay inside the dialog while it is open. Focus is restored to whichever
 * element opened the modal once it closes.
 */
export function CommandForm(props: CommandFormProps): ReactElement | null {
  const {
    command,
    mode,
    onClose,
    onDirtyChange,
    runTarget = "embedded",
    categorySuggestions = [],
    tagSuggestions = [],
    initialScript,
  } = props;
  const { t } = useTranslation();
  // History-aware wrappers — see services/commandActions.ts. The
  // wrappers delegate to the same store methods, so existing test
  // spies that replace `useCommandStore.getState().addCommand` keep
  // working as long as the spy returns a `Command`-shaped value.
  const addCommand = createCommandWithHistory;
  const updateCommand = updateCommandWithHistory;

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const platform = getCachedPlatform();
  // Snapshot the available-shells cache once per mount. The shell list
  // cannot change for the lifetime of the process — `loadAvailableShells`
  // fetches it once at startup and never invalidates — so we don't need
  // to subscribe to changes. `null` (still loading) is treated as an
  // empty list; `pickCreateModeShell` falls back to the platform default
  // in that case.
  const availableShells: ReadonlyArray<Shell> = useMemo(
    () => getCachedAvailableShells() ?? [],
    [],
  );

  // Re-initialize whenever a new open is requested. We key off the command's
  // id (or "create" for the create path) so re-opening the same edit target
  // resets the form rather than retaining stale typing from a previous open.
  const initial = useMemo(
    () => buildInitialState(command, mode, t, platform, availableShells, initialScript),
    // `t` deliberately not in deps: changing language while the form is open
    // should not overwrite what the user has typed.
    // `initialScript` is intentionally omitted: it's the one-shot seed value
    // for create mode and must not re-initialize the form if a parent re-renders
    // with a different value after the user has already started typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [command?.id, mode],
  );

  const [form, setForm] = useState<FormState>(initial);
  const [showErrors, setShowErrors] = useState<boolean>(false);

  // Flag builder: open/closed state + parsed CLI data fetched on demand.
  const [flagBuilderOpen, setFlagBuilderOpen] = useState<boolean>(false);
  const [flagBuilderData, setFlagBuilderData] = useState<ParsedCli | null>(null);
  const [flagBuilderLoading, setFlagBuilderLoading] = useState<boolean>(false);

  // Dirty tracking for the host's unsaved-changes guard. We compare a
  // STABLE projection of the form against its initial snapshot, excluding
  // UI-only fields that never reach the saved command: per-row `rowId`
  // (random) and `nameTouched` (interaction flag). `disableHints` is an
  // editing-session preference, not part of the command, so it's also
  // excluded — toggling it must not count as an unsaved change.
  const isDirty = useMemo(
    () => fingerprintForm(form) !== fingerprintForm(initial),
    [form, initial],
  );
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Publish the live (possibly unsaved) Script body to the UI store while the
  // full-screen editor has an existing command open, so a re-run from the
  // OutputPanel ("Повторить") replays what the user is currently editing
  // rather than the last-saved version. Gated to the global-console editor in
  // edit mode (the create path has no command id to correlate against). The
  // value is cleared on unmount / target change so it can never leak into a
  // later run of a different command.
  const setCommandEditorLiveScript = useUIStore(
    (s) => s.setCommandEditorLiveScript,
  );
  const liveScriptTarget =
    runTarget === "global" && mode === "edit" && command !== null
      ? command.id
      : null;
  useEffect(() => {
    if (liveScriptTarget === null) return;
    setCommandEditorLiveScript(form.script);
  }, [liveScriptTarget, form.script, setCommandEditorLiveScript]);
  useEffect(() => {
    if (liveScriptTarget === null) return;
    return () => setCommandEditorLiveScript(null);
  }, [liveScriptTarget, setCommandEditorLiveScript]);
  // Reset the host's dirty flag when the form unmounts so a later
  // navigation isn't blocked by a stale "dirty" signal.
  useEffect(() => {
    return () => onDirtyChange?.(false);
    // Run only on unmount; `onDirtyChange` identity is stable from the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Run-as-administrator concerns: the cached "password stored?" hint flag
  // and inline-escalation auto-detection. See useAdminEscalation.
  const { adminPasswordStored, setAdminPasswordStored, escalationDetected } =
    useAdminEscalation(form, setForm);

  // Active tab. The form's fields are split across four tabs so the
  // long single scroll becomes navigable. Panels are hidden (not
  // unmounted) when inactive so the ScriptEditor state, focus, and any
  // in-flight live-run stay intact across tab switches.
  const [activeTab, setActiveTab] = useState<FormTab>("main");

  // Snapshot of process environment variables, used to detect when a
  // command's env overrides shadow a system variable. Loaded once on
  // mount and cached for the lifetime of the app (env vars don't
  // change at runtime).
  const [userVars, setUserVars] = useState<Record<string, string>>(
    () => getCachedProcessEnv() ?? {},
  );
  useEffect(() => {
    if (Object.keys(userVars).length > 0) return;
    void getProcessEnv().then((vars) => setUserVars(vars));
  // Run only once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // For elevated commands, prefer the cached root-env snapshot for the
  // "overrides system variable" badge so the comparison is accurate (6.3).
  // Root snapshot is only used when already loaded (no prompt triggered here).
  const rootState = useEnvManagerStore((s) => s.rootState);
  const systemVars: Record<string, string> = (() => {
    if (form.runAsAdmin && rootState.kind === "loaded") {
      return Object.fromEntries(
        rootState.snapshot.vars.map((v: { key: string; value: string }) => [v.key, v.value]),
      );
    }
    return userVars;
  })();

  // Live-run lifecycle (embedded panel + global-console path). See
  // useCommandLiveRun. The hook owns runResult/outputCollapsed, the event
  // plumbing, admin-password sentinel retries, and teardown.
  const {
    runResult,
    outputCollapsed,
    setOutputCollapsed,
    globalExecution,
    isGlobalRunning,
    run: handleRun,
    cancel: handleCancel,
    clear: handleClearOutput,
    runGlobal: handleRunGlobal,
    cancelGlobal: handleCancelGlobal,
    resetRun,
    cancelActiveRunForSave,
    teardownRun,
    closeWithRunGuard,
  } = useCommandLiveRun(form, {
    command,
    runTarget,
    setAdminPasswordStored,
    t,
  });

  // Reset state when the open target changes. Includes the run output —
  // re-opening edit on a different command starts with a fresh panel.
  useEffect(() => {
    setForm(initial);
    setShowErrors(false);
    setTagDraft("");
    resetRun();
    setActiveTab("main");
  }, [initial, resetRun]);

  const errors: FormErrors = useMemo(() => {
    const next: FormErrors = {};
    if (form.name.trim() === "") {
      next.name = t("commandForm.errors.nameRequired");
    }
    if (form.script.trim() === "") {
      next.script = t("commandForm.errors.scriptRequired");
    }
    return next;
  }, [form.name, form.script, t]);

  // Per-row variable errors. Stored separately from `errors` (which
  // covers the scalar top-level fields) because the UI needs to render
  // each error next to its row, and rows are keyed by index here.
  const variableErrors = useMemo(
    () => computeVariableErrors(form.variables),
    [form.variables],
  );
  const hasVariableErrors = variableErrors.some((e) => e !== undefined);

  const hasErrors =
    errors.name !== undefined ||
    errors.script !== undefined ||
    hasVariableErrors;

  // Which tab each validation error belongs to, so the tab strip can show
  // an error badge and Save can jump to the first offending tab. The
  // output tab has no validation today.
  const mainTabHasError = errors.name !== undefined;
  const scriptTabHasError =
    errors.script !== undefined || hasVariableErrors;

  const handleSave = useCallback((): void => {
    if (hasErrors) {
      setShowErrors(true);
      // Jump to the first tab carrying an error so the user sees it even
      // if they're on a different tab. Name (main) takes precedence over
      // script/variables (script).
      if (errors.name !== undefined) {
        setActiveTab("main");
      } else if (errors.script !== undefined || hasVariableErrors) {
        setActiveTab("script");
      }
      return;
    }
    const trimmedName = form.name.trim();
    const trimmedScript = form.script.trim();
    const trimmedDescription = form.description.trim();
    const descriptionValue =
      trimmedDescription.length > 0 ? trimmedDescription : undefined;
    // Defensive: re-detect at save time against the trimmed script so
    // a user who pasted `sudo …` and hit Save in the same tick still
    // gets the correct flag. The useEffect above will normally have
    // already flipped form.runAsAdmin to true by the time Save fires,
    // but recomputing here makes the save path independent of effect
    // ordering and impossible to bypass by tampering with the input
    // state through devtools or future refactors.
    const runAsAdminValue =
      form.runAsAdmin || detectAdminEscalation(trimmedScript);

    // Convert UI rows to wire-format specs. Empty list → omit the
    // field entirely from the saved Command (matches the `args` / `env`
    // convention elsewhere in this file). For the edit path we always
    // write the field — including as `undefined` — so the persisted
    // record reflects a user who cleared every row.
    const variablesValue: VariableSpec[] | undefined =
      form.variables.length > 0
        ? rowsToVariableSpecs(form.variables)
        : undefined;

    // Tags: normalized (trim/dedupe/no-empties). Category: a blank
    // input maps to `undefined` (no category) rather than an empty
    // string, so the stored field is either a real name or absent.
    const tagsValue = normalizeTags(form.tags);
    const trimmedCategory = form.category.trim();
    const categoryValue =
      trimmedCategory.length > 0 ? trimmedCategory : undefined;

    if (mode === "edit" && command) {
      // Seed-to-user conversion: when a seed is edited, drop the
      // translation keys so the literal values become canonical.
      const patch: Partial<Command> = {
        name: trimmedName,
        description: descriptionValue,
        script: trimmedScript,
        shell: form.shell,
        tags: tagsValue,
        // Explicit `categoryId` (including `undefined`) so clearing the
        // category field drops it on the stored command rather than
        // leaving the old value behind the store's spread merge.
        categoryId: categoryValue,
        runAsAdmin: runAsAdminValue,
        // Explicit field on the patch so clearing all rows (transition
        // from N>0 to 0) drops the field on the stored command. The
        // store's spread merge would otherwise leave the old value.
        variables: variablesValue,
        timeoutSeconds: parseTimeoutSeconds(form.timeoutSeconds),
        // Explicit field so clearing the schema (toggle off) drops it on
        // the stored command rather than leaving the old value behind.
        outputSchema: form.outputSchema,
        // Explicit field so clearing all env rows drops Command.env.
        env: envRowsToRecord(form.envRows),
        // Explicit field so clearing the working dir resets it to the default.
        workingDir: form.workingDir.trim() !== "" ? form.workingDir.trim() : undefined,
        promptWorkingDir: form.promptWorkingDir || undefined,
      };
      if (command.nameKey !== undefined) patch.nameKey = undefined;
      if (command.descriptionKey !== undefined) {
        patch.descriptionKey = undefined;
      }
      updateCommand(command.id, patch);
    } else {
      const envValue = envRowsToRecord(form.envRows);
      addCommand({
        name: trimmedName,
        description: descriptionValue,
        script: trimmedScript,
        shell: form.shell,
        tags: tagsValue,
        favorite: false,
        runAsAdmin: runAsAdminValue,
        // Omit the optional keys entirely when empty to match the
        // `args`/`env` convention — `addCommand` accepts
        // `Omit<Command, ...>` so optional fields are naturally elidable.
        ...(categoryValue !== undefined ? { categoryId: categoryValue } : {}),
        ...(variablesValue !== undefined ? { variables: variablesValue } : {}),
        ...(parseTimeoutSeconds(form.timeoutSeconds) !== undefined
          ? { timeoutSeconds: parseTimeoutSeconds(form.timeoutSeconds) }
          : {}),
        ...(form.outputSchema !== undefined
          ? { outputSchema: form.outputSchema }
          : {}),
        ...(envValue !== undefined ? { env: envValue } : {}),
        ...(form.workingDir.trim() !== "" ? { workingDir: form.workingDir.trim() } : {}),
        ...(form.promptWorkingDir ? { promptWorkingDir: true } : {}),
      });
    }
    // If a live-run is still active when the user saves, cancel it so
    // we don't leak a background process after the modal closes.
    cancelActiveRunForSave();
    // The changes are now persisted, so the form is no longer "dirty".
    // Clear the host's dirty flag BEFORE navigating: `onClose` funnels
    // through `requestNavigation`, which would otherwise see a stale
    // dirty signal (our `isDirty` compares `form` to the original
    // `initial` snapshot and stays true even after the save) and park the
    // navigation behind the unsaved-changes confirm dialog.
    onDirtyChange?.(false);
    teardownRun();
    onClose();
  }, [
    addCommand,
    command,
    form.description,
    form.name,
    form.script,
    form.shell,
    form.tags,
    form.category,
    form.runAsAdmin,
    form.variables,
    form.timeoutSeconds,
    form.outputSchema,
    form.envRows,
    form.workingDir,
    form.promptWorkingDir,
    errors,
    hasErrors,
    hasVariableErrors,
    mode,
    onClose,
    onDirtyChange,
    cancelActiveRunForSave,
    teardownRun,
    updateCommand,
  ]);

  // Focus the name input when the view opens (select all in edit mode for
  // a quick rename). Deferred a tick so the layout has painted first.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const input = nameInputRef.current;
      if (!input) return;
      input.focus();
      if (mode === "edit") {
        input.select();
      }
    }, 0);
    return () => {
      window.clearTimeout(id);
    };
    // We intentionally re-run this effect when the open target changes so a
    // re-open after an internal close cycles focus correctly.
  }, [command?.id, mode]);

  /**
   * Close the modal, cancelling any in-flight live-run first. The live-run
   * hook owns the cancel + grace-window logic (see `closeWithRunGuard`);
   * the unmount teardown is also handled inside the hook.
   */
  const requestClose = useCallback((): void => {
    closeWithRunGuard(onClose);
  }, [closeWithRunGuard, onClose]);

  // Global key handler: Cmd/Ctrl+Enter saves. We listen on window because
  // focus may be inside the textarea where the default key behaviour would
  // otherwise consume Enter. Escape intentionally does NOT close the view
  // — this is a full-screen form, not a modal, so leaving is an explicit
  // navigation (Cancel / sidebar), guarded by the unsaved-changes confirm.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  const handleNameChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setForm((s) => ({ ...s, name: e.target.value }));
  };
  const handleDescriptionChange = (
    e: ChangeEvent<HTMLTextAreaElement>,
  ): void => {
    setForm((s) => ({ ...s, description: e.target.value }));
  };

  // ---------------------------------------------------------------
  // Tag chip editor. The text input holds the in-progress tag; Enter
  // or comma commits it as a chip, Backspace on an empty input removes
  // the last chip. Committed tags are deduped case-insensitively against
  // what's already present (first casing wins) and never empty.
  // ---------------------------------------------------------------
  const [tagDraft, setTagDraft] = useState<string>("");
  const [tagSuggestActiveIndex, setTagSuggestActiveIndex] = useState<number>(-1);

  const filteredTagSuggestions = useMemo((): string[] => {
    const draft = tagDraft.trim();
    if (draft === "") return [];
    const lower = draft.toLowerCase();
    return tagSuggestions.filter(
      (t) =>
        t.toLowerCase().includes(lower) &&
        !form.tags.some((existing) => existing.toLowerCase() === t.toLowerCase()),
    );
  }, [tagDraft, tagSuggestions, form.tags]);
  // ---------------------------------------------------------------
  // Category dropdown state. `addingCategory` flips the field into an
  // inline text input for a brand-new category name; `newCategoryDraft`
  // holds that in-progress text; `sessionCategories` accumulates names
  // the user adds during this editing session so they appear in the
  // dropdown immediately (the persisted suggestion list only refreshes
  // after a save round-trips through the store).
  // ---------------------------------------------------------------
  const [addingCategory, setAddingCategory] = useState<boolean>(false);
  const [newCategoryDraft, setNewCategoryDraft] = useState<string>("");
  const [sessionCategories, setSessionCategories] = useState<string[]>([]);

  const handleCategorySelect = useCallback((next: string): void => {
    if (next === CATEGORY_NEW_SENTINEL) {
      // Switch the field into "add a new category" mode. The inline
      // input below handles confirm/cancel.
      setNewCategoryDraft("");
      setAddingCategory(true);
      return;
    }
    setAddingCategory(false);
    // `CATEGORY_NONE_SENTINEL` ("") maps to "no category".
    setForm((s) => ({ ...s, category: next }));
  }, []);

  /** Confirm the inline new-category input: trim, commit to the form,
   *  and remember it for this session so it shows up in the dropdown. */
  const handleCategoryAddConfirm = useCallback((): void => {
    const trimmed = newCategoryDraft.trim();
    setAddingCategory(false);
    setNewCategoryDraft("");
    if (trimmed === "") {
      // Blank confirm → treat as "no category" rather than inventing one.
      setForm((s) => ({ ...s, category: "" }));
      return;
    }
    setSessionCategories((prev) =>
      prev.some((c) => c.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setForm((s) => ({ ...s, category: trimmed }));
  }, [newCategoryDraft]);

  const handleCategoryAddCancel = useCallback((): void => {
    setAddingCategory(false);
    setNewCategoryDraft("");
  }, []);

  // Timeout stepper: adjust the seconds value by `delta`, clamping at a
  // floor of 0 ("no limit" — represented as the empty string). An empty
  // field is treated as 0 for the purpose of incrementing, so the first
  // "+" click yields 1. Non-numeric/garbage current values reset to the
  // clamped delta rather than producing NaN.
  const adjustTimeout = useCallback((delta: number): void => {
    setForm((s) => {
      const current = Number.parseInt(s.timeoutSeconds, 10);
      const base = Number.isFinite(current) ? current : 0;
      const next = base + delta;
      return {
        ...s,
        // 0 (or below) means "no limit" → store the empty string so the
        // placeholder shows and `parseTimeoutSeconds` yields undefined.
        timeoutSeconds: next <= 0 ? "" : String(next),
      };
    });
  }, []);

  useEffect(() => {
    setTagSuggestActiveIndex(-1);
  }, [filteredTagSuggestions]);

  const commitTag = useCallback((raw: string): void => {
    const trimmed = raw.trim();
    setTagDraft("");
    if (trimmed === "") return;
    setForm((s) => {
      const exists = s.tags.some(
        (tag) => tag.toLowerCase() === trimmed.toLowerCase(),
      );
      return exists ? s : { ...s, tags: [...s.tags, trimmed] };
    });
  }, []);

  const handleRemoveTag = useCallback((index: number): void => {
    setForm((s) => ({
      ...s,
      tags: s.tags.filter((_, i) => i !== index),
    }));
  }, []);

  const handleTagInputKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (filteredTagSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setTagSuggestActiveIndex((i) =>
          i < filteredTagSuggestions.length - 1 ? i + 1 : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setTagSuggestActiveIndex((i) =>
          i > 0 ? i - 1 : filteredTagSuggestions.length - 1,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTagDraft("");
        return;
      }
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const activeTag = filteredTagSuggestions[tagSuggestActiveIndex];
      if (activeTag !== undefined) {
        commitTag(activeTag);
      } else {
        commitTag(tagDraft);
      }
      return;
    }
    if (e.key === "Backspace" && tagDraft === "" && form.tags.length > 0) {
      e.preventDefault();
      handleRemoveTag(form.tags.length - 1);
    }
  };
  // Variable specs derived from the current row state, scoped to
  // what the ScriptEditor needs (only `name` is actually consulted
  // for highlighting; passing the full spec keeps the interface
  // future-proof). Memoised so the editor's `useMemo` over `variables`
  // doesn't bust on every keystroke in unrelated fields.
  const scriptVariableSpecs = useMemo<VariableSpec[]>(
    () => rowsToVariableSpecs(form.variables),
    [form.variables],
  );
  // Leading utility of the script (first command of the first executable
  // line) WITH its position, or null when there's no recognisable bare
  // utility (empty, a `${var}` reference, a path, etc.). Drives the
  // in-text flag hint: the token is highlighted in the editor overlay and
  // hovering it shows the utility's --help/man popover. `useUtilityHelp`
  // debounces + caches the IPC lookup, so re-deriving per keystroke is
  // cheap.
  // When the user opts into "expert mode" (disableHints) we suppress the
  // utility range entirely: no highlight token is carved out, no IPC
  // lookup fires, and the hover popover has nothing to anchor to. We do
  // this at the SOURCE (the range) rather than only hiding the visuals
  // so the `--help`/`man` child process is never spawned for a user who
  // explicitly turned hints off.
  const utilityRange = useMemo(
    () =>
      form.disableHints ? null : parseUtilityNameWithRange(form.script),
    [form.script, form.disableHints],
  );
  const utilityHelp = useUtilityHelp(utilityRange?.name ?? null);

  // Highlight descriptor for the editor overlay: the token's offsets plus
  // a colour status derived from the resolved lookup. While the lookup is
  // idle/loading the status is "pending" so the token renders WITHOUT a
  // green/red colour (avoids a flash before the answer arrives).
  const resolvedHelp =
    typeof utilityHelp.state === "object" ? utilityHelp.state : null;
  const utilityHighlight = useMemo<UtilityHighlight | null>(() => {
    if (!utilityRange) return null;
    const status: UtilityHighlightStatus =
      resolvedHelp === null
        ? "pending"
        : resolvedHelp.status === "found"
          ? "found"
          : "not-found";
    return { start: utilityRange.start, end: utilityRange.end, status };
  }, [utilityRange, resolvedHelp]);

  // Flag builder: fetch parsed CLI on demand, then open the inline section.
  const handleOpenFlagBuilder = useCallback((): void => {
    if (!utilityRange) return;
    setFlagBuilderLoading(true);
    void parseUtilityFlags(utilityRange.name).then((parsed) => {
      setFlagBuilderData(parsed);
      setFlagBuilderOpen(true);
      setFlagBuilderLoading(false);
    }).catch(() => {
      setFlagBuilderLoading(false);
    });
  }, [utilityRange]);

  // Fetch ParsedCli as soon as the utility is recognised (proactive — so flag
  // highlights appear without the user opening the builder). Re-fetches when
  // the utility name changes. Tracks the last *fetched* name so a status
  // transition loading→found for the same name doesn't trigger a second fetch.
  //
  // `flagBuilderOpen` is intentionally NOT in the dep array: opening/closing
  // the builder must not re-trigger this effect. The builder open/close path
  // is handled separately in handleOpenFlagBuilder / handleFlagBuilderDismiss.
  const fetchedUtilityRef = useRef<string | null>(null);
  const flagBuilderOpenRef = useRef(flagBuilderOpen);
  flagBuilderOpenRef.current = flagBuilderOpen;
  useEffect(() => {
    const name = utilityRange?.name ?? null;
    const isFound = resolvedHelp?.status === "found";

    if (!name || !isFound) {
      fetchedUtilityRef.current = null;
      setFlagBuilderData(null);
      if (flagBuilderOpenRef.current) setFlagBuilderOpen(false);
      return;
    }

    if (fetchedUtilityRef.current === name) return;
    fetchedUtilityRef.current = name;

    void parseUtilityFlags(name).then((parsed) => {
      setFlagBuilderData(parsed);
    }).catch(() => {
      fetchedUtilityRef.current = null;
      setFlagBuilderData(null);
      if (flagBuilderOpenRef.current) setFlagBuilderOpen(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utilityRange?.name, resolvedHelp?.status]);

  const handleFlagBuilderChange = useCallback((script: string): void => {
    setForm((s) => ({ ...s, script }));
  }, []);

  const handleFlagBuilderDismiss = useCallback((): void => {
    setFlagBuilderOpen(false);
    // Do NOT clear flagBuilderData — it is still used for flag highlighting
    // in the ScriptEditor overlay even when the builder panel is closed.
  }, []);

  // ---------------------------------------------------------------
  // Variable-row mutation handlers. Each operates on the row at
  // `index` (the row identity is the array position). The handlers
  // are intentionally simple — no debouncing, no batching — because
  // the row count is bounded by what a human will reasonably declare
  // and re-rendering 30+ rows on every keystroke is still trivial.
  // ---------------------------------------------------------------
  const handleVariableAdd = useCallback((): void => {
    setForm((s) => ({
      ...s,
      variables: [
        ...s.variables,
        {
          rowId: makeRowId(),
          name: "",
          defaultValue: "",
          description: "",
          sensitive: false,
          // New rows default to "prompt at runtime" — the safest
          // default since an empty string is a meaningful value but
          // unlikely to be what the user wants for a fresh variable.
          promptAtRuntime: true,
          // Fresh row: don't show the "invalid name" error yet. The
          // flag flips to true on first input or blur, or via the
          // global `showErrors` switch on save.
          nameTouched: false,
        },
      ],
    }));
  }, []);

  const handleVariableRemove = useCallback((index: number): void => {
    setForm((s) => ({
      ...s,
      variables: s.variables.filter((_, i) => i !== index),
    }));
  }, []);

  const updateVariableRow = useCallback(
    (index: number, patch: Partial<VariableRow>): void => {
      setForm((s) => {
        const updatedVariables = s.variables.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        );
        // When the default value of a named variable changes, keep every
        // ${name} / ${name:old} reference in the script in sync.
        if ('defaultValue' in patch) {
          const name = updatedVariables[index]?.name;
          if (name) {
            return {
              ...s,
              variables: updatedVariables,
              script: syncVariableDefaultToScript(s.script, name, patch.defaultValue ?? ''),
            };
          }
        }
        return { ...s, variables: updatedVariables };
      });
    },
    [],
  );

  const handleOutputSchemaChange = useCallback(
    (next: OutputSchema | undefined): void => {
      setForm((s) => ({ ...s, outputSchema: next }));
    },
    [],
  );

  // ---------------------------------------------------------------
  // Env-row mutation handlers.
  // ---------------------------------------------------------------
  const handleEnvRowAdd = useCallback((): void => {
    setForm((s) => ({
      ...s,
      envRows: [
        ...s.envRows,
        { rowId: makeRowId(), key: "", value: "" } satisfies EnvRow,
      ],
    }));
  }, []);

  const handleEnvRowRemove = useCallback((index: number): void => {
    setForm((s) => ({
      ...s,
      envRows: s.envRows.filter((_, i) => i !== index),
    }));
  }, []);

  const updateEnvRow = useCallback(
    (index: number, patch: Partial<EnvRow>): void => {
      setForm((s) => ({
        ...s,
        envRows: s.envRows.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        ),
      }));
    },
    [],
  );

  // stdout of the most recent in-form run, fed to the output-schema
  // editor so its "sample output" textarea auto-fills from a real run.
  // Per the spec this only ever reflects a run launched from THIS edit
  // form: it derives purely from `runResult` (the in-form terminal) and
  // only once that run has reached a terminal state — partial/streaming
  // output isn't a stable sample to preview against. `undefined` while
  // idle/running so the editor keeps whatever the user has typed.
  const runStdoutSample = useMemo<string | undefined>(() => {
    // In global-console mode the run goes through the execution store,
    // so derive the sample from the tracked global execution's stdout.
    // Otherwise use the embedded `runResult`.
    if (runTarget === "global") {
      const status = globalExecution?.status;
      const terminal =
        status === "success" || status === "error" || status === "cancelled";
      if (!terminal || !globalExecution) return undefined;
      const stdout = globalExecution.log
        .filter((l) => l.stream === "stdout")
        .map((l) => l.line)
        .join("\n");
      return stdout === "" ? undefined : stdout;
    }
    const terminal =
      runResult.status === "finished" ||
      runResult.status === "failed" ||
      runResult.status === "cancelled" ||
      runResult.status === "timedOut";
    if (!terminal) return undefined;
    const stdout = runResult.lines
      .filter((l) => l.stream === "stdout")
      .map((l) => l.text)
      .join("\n");
    return stdout === "" ? undefined : stdout;
  }, [runTarget, globalExecution, runResult.status, runResult.lines]);

  const handleShellChange = useCallback((next: string): void => {
    // The dropdown is configured with the `Shell` union values, so the
    // string returned here is guaranteed to be a valid Shell at runtime.
    // We narrow with a guard rather than an unchecked cast to keep the
    // assumption explicit and protect against future option-list edits.
    if (isShell(next)) {
      setForm((s) => ({ ...s, shell: next }));
    }
  }, []);

  if (command === null && mode === "edit") return null;

  const title =
    mode === "create"
      ? t("commandForm.title.create")
      : t("commandForm.title.edit");
  const saveLabel =
    mode === "create"
      ? t("commandForm.actions.create")
      : t("commandForm.actions.save");

  // Build the shell dropdown options every render. Cheap (at most ~8
  // entries); cannot meaningfully be memoized because both
  // `form.shell` and `t` change at different cadences.
  const shellOptions = buildShellOptions(
    form.shell,
    availableShells,
    t("commandForm.shellUnavailableSuffix"),
  );
  // Show the "no shells detected" advisory only when detection has
  // resolved (cache !== null) and returned an empty list. While the
  // cache is still loading we keep the advisory hidden to avoid a
  // misleading flash; the platform-default fallback covers that case.
  const detectionResolved = getCachedAvailableShells() !== null;
  const showNoShellsWarning = detectionResolved && availableShells.length === 0;

  // Build the Category dropdown options: "No category" first, then the
  // union of persisted suggestions, any names added this session, and the
  // command's own current value (so an edited command whose category is
  // not in the persisted list still shows its value as selected), then a
  // trailing "New category…" action. De-duped case-insensitively with
  // first-casing-wins, and sorted for a stable, scannable list.
  const categoryOptions: ReadonlyArray<DropdownOption> = (() => {
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
    consider(form.category);
    names.sort((a, b) => a.localeCompare(b));
    return [
      { value: CATEGORY_NONE_SENTINEL, label: t("commandForm.placeholders.categorySelect") },
      ...names.map((n) => ({ value: n, label: n })),
      { value: CATEGORY_NEW_SENTINEL, label: t("commandForm.placeholders.categoryNew") },
    ];
  })();

  return (
      <div className="command-form">
        {/*
         * Top bar: the form title on the left, the primary actions
         * (Run / Cancel / Save) on the right. Moved here from a bottom
         * footer so the actions sit beside the title at the top of the
         * full-screen view. The bar is a fixed-height sibling of the
         * scrolling body, so it stays put as the body scrolls.
         */}
        <header className="command-form__topbar">
          <h1 className="command-form__topbar-title">{title}</h1>
          <div className="command-form__topbar-actions">
            {(() => {
              // The Run button's behavior follows the active run target:
              //   - global: status comes from the execution store; clicks
              //     launch/cancel on the app-wide console.
              //   - embedded: the original inline live-run path.
              const running =
                runTarget === "global"
                  ? isGlobalRunning
                  : runResult.status === "running";
              const onClick =
                runTarget === "global"
                  ? running
                    ? handleCancelGlobal
                    : () => void handleRunGlobal()
                  : running
                    ? handleCancel
                    : () => void handleRun();
              return (
                <button
                  type="button"
                  className={`btn command-form__action ${
                    running
                      ? "command-form__action--cancel"
                      : "command-form__action--run"
                  }`}
                  onClick={onClick}
                  disabled={!running && form.script.trim() === ""}
                >
                  {running ? (
                    <span className="command-form__action-icon--cancel">
                      <CancelIcon />
                    </span>
                  ) : (
                    <span className="command-form__action-icon--run">
                      <RunIcon />
                    </span>
                  )}
                  {running
                    ? t("commandForm.actions.cancelRun")
                    : t("commandForm.actions.run")}
                </button>
              );
            })()}
            <button
              type="button"
              className="btn command-form__action command-form__action--cancel"
              onClick={requestClose}
            >
              <span className="command-form__action-icon--cancel">
                <CancelIcon />
              </span>
              {t("commandForm.actions.cancel")}
            </button>
            <button
              type="button"
              className={`btn btn--primary command-form__action${
                hasErrors ? " command-form__action--invalid" : ""
              }`}
              onClick={handleSave}
              // Intentionally NOT `disabled` when there are errors: a
              // disabled Save can't tell the user WHY it's blocked. Instead
              // Save stays clickable and `handleSave` reveals the errors and
              // jumps to the first offending tab. `aria-disabled` conveys the
              // invalid state to assistive tech without swallowing the click.
              aria-disabled={hasErrors}
            >
              <SaveIcon />
              {saveLabel}
            </button>
          </div>
        </header>

        {/*
         * Tab strip. Splits the form into Main / Script / Output so the
         * long single scroll becomes navigable. An error badge marks the
         * tab(s) whose fields fail validation (shown once Save is pressed),
         * and Save jumps to the first offending tab.
         */}
        <div className="command-form__tabs" role="tablist">
          {(
            [
              { key: "main", hasError: mainTabHasError },
              { key: "script", hasError: scriptTabHasError },
              { key: "output", hasError: false },
              { key: "env", hasError: false },
            ] as ReadonlyArray<{ key: FormTab; hasError: boolean }>
          ).map(({ key, hasError }) => {
            const showBadge = showErrors && hasError;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`command-form-tab-${key}`}
                aria-controls={`command-form-panel-${key}`}
                aria-selected={activeTab === key}
                className={`command-form__tab${
                  activeTab === key ? " is-active" : ""
                }`}
                onClick={() => setActiveTab(key)}
              >
                {t(`commandForm.tabs.${key}`)}
                {showBadge ? (
                  <span
                    className="command-form__tab-badge"
                    aria-label={t("commandForm.tabs.hasErrors", {
                      defaultValue: "has errors",
                    })}
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="command-form__body">
          {/* --- Tab: Main (metadata + execution settings) --- */}
          <div
            role="tabpanel"
            id="command-form-panel-main"
            aria-labelledby="command-form-tab-main"
            hidden={activeTab !== "main"}
            className="command-form__panel"
          >
          <label className="command-form__field">
            <span className="command-form__label command-form__label--required">
              <span
                className="command-form__required"
                aria-hidden="true"
              >
                *
              </span>
              {t("commandForm.fields.name")}
            </span>
            <input
              ref={nameInputRef}
              type="text"
              className="input"
              value={form.name}
              onChange={handleNameChange}
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
              onChange={handleDescriptionChange}
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
                  placeholder={t("commandForm.placeholders.tags")}
                  aria-label={t("commandForm.fields.tags")}
                  autoComplete="off"
                />
              </div>
              {filteredTagSuggestions.length > 0 ? (
                <ul className="tag-suggest" role="listbox" aria-label={t("commandForm.fields.tags")}>
                  {filteredTagSuggestions.map((suggestion, idx) => (
                    <li
                      key={suggestion}
                      className={
                        "tag-suggest__option" +
                        (idx === tagSuggestActiveIndex ? " tag-suggest__option--active" : "")
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
                      handleCategoryAddConfirm();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      handleCategoryAddCancel();
                    }
                  }}
                  placeholder={t("commandForm.category.addNewPlaceholder")}
                  aria-label={t("commandForm.category.addNewTitle")}
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleCategoryAddConfirm}
                >
                  {t("commandForm.category.addNewConfirm")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleCategoryAddCancel}
                >
                  {t("commandForm.category.addNewCancel")}
                </button>
              </div>
            ) : (
              <Dropdown
                value={form.category}
                options={categoryOptions}
                onChange={handleCategorySelect}
                ariaLabel={t("commandForm.fields.category")}
              />
            )}
          </div>

          <div className="command-form__field">
            <span className="command-form__label">
              {t("commandForm.fields.shell")}
            </span>
            <Dropdown
              value={form.shell}
              options={shellOptions}
              onChange={handleShellChange}
              ariaLabel={t("commandForm.fields.shell")}
            />
            {showNoShellsWarning ? (
              <span className="command-form__warning" role="note">
                {t("commandForm.warnings.noShellsDetected")}
              </span>
            ) : null}
          </div>

          {/*
           * Admin checkbox. When checked, the command spawns with
           * elevated privileges (sudo on Unix, UAC on Windows). The
           * label uses a `<label>` wrapper so clicking the text also
           * toggles the input — matches the favorite/checkbox style
           * elsewhere in the app. Hint copy is platform-conditional:
           *   - Windows: warn that live-output capture is limited
           *     (the UAC child runs in a different security context).
           *   - Unix + no password stored yet: explain the first-run
           *     password prompt so the modal doesn't surprise users.
           *
           * When the script itself starts with sudo/doas/pkexec, we
           * force the checkbox on and disable it (see
           * `escalationDetected` above). The hint below explains why.
           */}
          <label
            className={`command-form__field command-form__field--inline${
              escalationDetected ? " command-form__field--locked" : ""
            }`}
            title={
              escalationDetected
                ? t("commandForm.tooltips.runAsAdminAutoDetected", {
                    defaultValue:
                      "Detected sudo/doas/pkexec at the start of the script — admin mode is required.",
                  })
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={form.runAsAdmin}
              disabled={escalationDetected}
              onChange={(e) =>
                setForm((s) => ({ ...s, runAsAdmin: e.target.checked }))
              }
            />
            <span>
              {t("commandForm.fields.runAsAdmin", {
                defaultValue: "Run as administrator",
              })}
            </span>
          </label>
          {escalationDetected ? (
            <span className="command-form__hint" role="note">
              {t("commandForm.hints.runAsAdminAutoDetected", {
                defaultValue:
                  "Detected sudo/doas/pkexec at the start of the script. Admin mode is required and can't be disabled until you remove the escalation prefix.",
              })}
            </span>
          ) : null}
          {form.runAsAdmin && platform === "windows" ? (
            <span className="command-form__hint" role="note">
              {t("commandForm.warnings.windowsAdmin", {
                defaultValue:
                  "Windows will show a UAC prompt. Live output capture is limited.",
              })}
            </span>
          ) : null}
          {form.runAsAdmin &&
          platform !== "windows" &&
          !adminPasswordStored ? (
            <span className="command-form__hint" role="note">
              {t("commandForm.warnings.adminPasswordWillAsk", {
                defaultValue:
                  "You'll be asked for your administrator password on the first run.",
              })}
            </span>
          ) : null}

          <div className="command-form__field">
            <span className="command-form__label">
              {t("commandForm.fields.timeoutSeconds", {
                defaultValue: "Timeout (seconds)",
              })}
            </span>
            {/*
             * Timeout stepper. The native number-input spinner buttons
             * don't follow the app's visual language, so we hide them
             * (CSS, `.command-form__timeout-input`) and provide our own
             * ghost-button steppers that match the rest of the UI. The
             * text input is still freely editable for direct entry.
             */}
            <div className="command-form__timeout">
              <button
                type="button"
                className="btn btn--ghost btn--icon command-form__timeout-step"
                onClick={() => adjustTimeout(-1)}
                disabled={form.timeoutSeconds.trim() === ""}
                aria-label={t("commandForm.timeout.decrement")}
                title={t("commandForm.timeout.decrement")}
              >
                −
              </button>
              <input
                type="number"
                className="input command-form__timeout-input"
                min="1"
                step="1"
                value={form.timeoutSeconds}
                onChange={(e) =>
                  setForm((s) => ({ ...s, timeoutSeconds: e.target.value }))
                }
                placeholder={t("commandForm.placeholders.timeoutSeconds", {
                  defaultValue: "No limit",
                })}
              />
              <button
                type="button"
                className="btn btn--ghost btn--icon command-form__timeout-step"
                onClick={() => adjustTimeout(1)}
                aria-label={t("commandForm.timeout.increment")}
                title={t("commandForm.timeout.increment")}
              >
                +
              </button>
            </div>
          </div>
          </div>

          {/* --- Tab: Script (script editor + variables) --- */}
          <div
            role="tabpanel"
            id="command-form-panel-script"
            aria-labelledby="command-form-tab-script"
            hidden={activeTab !== "script"}
            className="command-form__panel"
          >
          <div className="command-form__field">
            <span className="command-form__label command-form__label--required">
              <span
                className="command-form__required"
                aria-hidden="true"
              >
                *
              </span>
              {t("commandForm.fields.script")}
            </span>
            {/*
             * "Expert mode" toggle. Sits between the Script label and the
             * editor. When checked it suppresses the leading-utility
             * highlight + hover help (see `disableHints` in form state).
             * Variable highlighting is unaffected — it reflects the
             * command's own declared variables, not an external hint.
             */}
            <label className="command-form__field command-form__field--inline command-form__disable-hints">
              <input
                type="checkbox"
                checked={form.disableHints}
                onChange={(e) =>
                  setForm((s) => ({ ...s, disableHints: e.target.checked }))
                }
              />
              <span>{t("commandForm.fields.disableHints")}</span>
            </label>
            {/*
             * Script field uses ScriptEditor (overlay-highlighting
             * textarea) so `${var}` references — typed or inserted
             * via the right-click "Insert variable" menu — are
             * visually distinguished. Known variables (declared in
             * the Variables section below) get one colour, unknown
             * ones another so typos stand out.
             *
             * `scriptVariableSpecs` is derived from the current row
             * state but only its `name` field is consulted by the
             * editor — see the highlight regex. We pass full specs
             * so future enhancements (e.g. show description on
             * hover over a highlighted reference) don't need a
             * prop-signature change.
             */}
            <ScriptEditor
              value={form.script}
              onChange={(next) =>
                setForm((s) => ({
                  ...s,
                  script: next,
                  variables: syncScriptDefaultsToRows(next, s.variables),
                }))
              }
              variables={scriptVariableSpecs}
              placeholder={t("commandForm.placeholders.script")}
              rows={8}
              ariaInvalid={showErrors && errors.script ? true : false}
              ariaDescribedBy={
                showErrors && errors.script
                  ? "command-form-script-error"
                  : undefined
              }
              utilityHighlight={utilityHighlight}
              utilityHelp={resolvedHelp}
              parsedFlags={flagBuilderData?.flags ?? null}
            />
            {showErrors && errors.script ? (
              <span
                id="command-form-script-error"
                className="command-form__error"
                role="alert"
              >
                {errors.script}
              </span>
            ) : null}

            {resolvedHelp?.status === "found" && !flagBuilderOpen ? (
              <div className="command-form__build-flags-wrap">
                <span className="command-form__build-flags-experimental">
                  {t("scriptFirstCreator.actionBuildExperimental")}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost command-form__build-flags"
                  onClick={handleOpenFlagBuilder}
                  disabled={flagBuilderLoading}
                >
                  {flagBuilderLoading
                    ? t("scriptFirstCreator.building")
                    : t("scriptFirstCreator.actionBuild")}
                </button>
              </div>
            ) : null}

            {flagBuilderOpen && flagBuilderData !== null ? (
              <FlagBuilder
                script={form.script}
                parsed={flagBuilderData}
                onChange={handleFlagBuilderChange}
                onDismiss={handleFlagBuilderDismiss}
              />
            ) : null}
          </div>

          <div className="command-form__field">
            <span className="command-form__label">
              {t("commandForm.fields.workingDir")}
            </span>
            <input
              type="text"
              className="input command-form__working-dir-input"
              value={form.workingDir}
              onChange={(e) =>
                setForm((s) => ({ ...s, workingDir: e.target.value }))
              }
              placeholder={t("commandForm.placeholders.workingDir")}
              aria-label={t("commandForm.fields.workingDir")}
            />
            <label className="command-form__field command-form__field--inline">
              <input
                type="checkbox"
                checked={form.promptWorkingDir}
                onChange={(e) =>
                  setForm((s) => ({ ...s, promptWorkingDir: e.target.checked }))
                }
              />
              <span>{t("commandForm.fields.promptWorkingDir")}</span>
            </label>
          </div>

          {/*
           * Variables section. Each row declares a `${name}` reference
           * that the runner will resolve at execution time. The
           * `promptAtRuntime` checkbox is the ONLY UI affordance that
           * produces `defaultValue === undefined` on the saved spec —
           * unchecking it preserves the empty string as a valid default
           * (see VariableSpec docs for the semantics). Errors are
           * computed by `computeVariableErrors` and shown inline; any
           * error on any row blocks submit via the form-level
           * `hasErrors` aggregation.
           */}
          <div className="command-form__field">
            <div className="command-form__variables-header">
              <span className="command-form__label">
                {t("commandForm.variables.title")}
              </span>
              {/*
               * Help affordance: an icon-only button paired with a
               * custom popover so the cheat-sheet stays open as long
               * as the cursor is over either the icon or the
               * popover itself. Native `title` was tried first but
               * browsers auto-dismiss it after a few seconds and
               * don't expose its lifetime — the popover gives us
               * that control. See `VariablesHelpTooltip` for the
               * open/close logic (hover-intent close delay +
               * focus/blur for keyboard users).
               */}
              <HelpTooltip
                id="command-form-variables-help"
                buttonLabel={t("commandForm.variables.help")}
                body={t("commandForm.variables.helpTooltip")}
              />
            </div>
            {form.variables.length > 0 ? (
              <ul className="command-form__variables">
                {form.variables.map((row, index) => {
                  const errorKind = variableErrors[index];
                  // Suppress `invalidName` until the user has actually
                  // interacted with the name field, OR until they hit
                  // Save (which flips `showErrors`). `duplicateName`
                  // always shows because it can only happen after the
                  // user has typed something. This keeps a freshly-
                  // added blank row from screaming at the user before
                  // they get a chance to type.
                  const suppressInvalid =
                    errorKind === "invalidName" &&
                    !row.nameTouched &&
                    !showErrors;
                  const visibleErrorKind = suppressInvalid
                    ? undefined
                    : errorKind;
                  const errorMessage =
                    visibleErrorKind === "invalidName"
                      ? t("commandForm.variables.errors.invalidName")
                      : visibleErrorKind === "duplicateName"
                        ? t("commandForm.variables.errors.duplicateName")
                        : null;
                  const errorId = `command-form-variable-${row.rowId}-error`;
                  return (
                    <li
                      key={row.rowId}
                      className="command-form__variables-row"
                    >
                      <div className="command-form__variables-row-fields">
                        <input
                          type="text"
                          className="input command-form__variables-name"
                          value={row.name}
                          onChange={(e) =>
                            updateVariableRow(index, {
                              name: e.target.value,
                              // Any keystroke counts as a touch so the
                              // user sees feedback as they type. Once
                              // touched, the flag stays true for the
                              // life of the row.
                              nameTouched: true,
                            })
                          }
                          onBlur={() => {
                            // Mark touched on blur too, in case the
                            // user tabbed in/out without typing.
                            if (!row.nameTouched) {
                              updateVariableRow(index, { nameTouched: true });
                            }
                          }}
                          placeholder={t(
                            "commandForm.variables.namePlaceholder",
                          )}
                          aria-label={t(
                            "commandForm.variables.namePlaceholder",
                          )}
                          aria-invalid={errorMessage ? true : undefined}
                          aria-describedby={
                            errorMessage ? errorId : undefined
                          }
                        />
                        <input
                          type="text"
                          className="input command-form__variables-default"
                          value={row.defaultValue}
                          onChange={(e) => {
                            const val = e.target.value;
                            updateVariableRow(index, {
                              defaultValue: val,
                              ...(val === '' ? { promptAtRuntime: true } : {}),
                            });
                          }}
                          placeholder={t(
                            "commandForm.variables.defaultValuePlaceholder",
                          )}
                          aria-label={t(
                            "commandForm.variables.defaultValuePlaceholder",
                          )}
                        />
                        <input
                          type="text"
                          className="input command-form__variables-description"
                          value={row.description}
                          onChange={(e) =>
                            updateVariableRow(index, {
                              description: e.target.value,
                            })
                          }
                          placeholder={t(
                            "commandForm.variables.descriptionPlaceholder",
                          )}
                          aria-label={t(
                            "commandForm.variables.descriptionPlaceholder",
                          )}
                        />
                        <div className="command-form__variables-toggles">
                          <label className="command-form__field command-form__field--inline">
                            <input
                              type="checkbox"
                              checked={row.promptAtRuntime}
                              onChange={(e) =>
                                updateVariableRow(index, {
                                  promptAtRuntime: e.target.checked,
                                })
                              }
                            />
                            <span>
                              {t("commandForm.variables.promptAtRuntime")}
                            </span>
                          </label>
                          <label className="command-form__field command-form__field--inline">
                            <input
                              type="checkbox"
                              checked={row.sensitive}
                              onChange={(e) =>
                                updateVariableRow(index, {
                                  sensitive: e.target.checked,
                                })
                              }
                            />
                            <span>{t("commandForm.variables.sensitive")}</span>
                          </label>
                          {row.sensitive ? (
                            <p className="form-hint">
                              {t("commandForm.variables.sensitiveLeakWarning")}
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon command-form__variables-remove"
                          onClick={() => handleVariableRemove(index)}
                          aria-label={t("commandForm.variables.remove")}
                          title={t("commandForm.variables.remove")}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                      {errorMessage ? (
                        <span
                          id={errorId}
                          className="command-form__error"
                          role="alert"
                        >
                          {errorMessage}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleVariableAdd}
            >
              {t("commandForm.variables.add")}
            </button>
          </div>
          </div>

          {/* --- Tab: Output (extraction schema) --- */}
          <div
            role="tabpanel"
            id="command-form-panel-output"
            aria-labelledby="command-form-tab-output"
            hidden={activeTab !== "output"}
            className="command-form__panel"
          >
          <OutputSchemaEditor
            value={form.outputSchema}
            onChange={handleOutputSchemaChange}
            sampleOutput={runStdoutSample}
            t={t}
          />
          </div>

          {/* --- Tab: Env (per-command environment variable overrides) --- */}
          <div
            role="tabpanel"
            id="command-form-panel-env"
            aria-labelledby="command-form-tab-env"
            hidden={activeTab !== "env"}
            className="command-form__panel"
          >
            <div className="command-form__field">
              <span className="command-form__label">
                {t("commandForm.env.title", { defaultValue: "Environment variables" })}
              </span>
              <span className="command-form__hint" role="note">
                {t("commandForm.env.hint", {
                  defaultValue:
                    "These KEY=VALUE pairs are injected into the command's environment at run time, overriding any inherited system variables with the same key.",
                })}
              </span>
            </div>
            {form.envRows.length > 0 ? (
              <ul className="command-form__env-list">
                {form.envRows.map((row, index) => {
                  const overridesSystem = isOverridingSystem(row.key, systemVars);
                  const invalidKey =
                    row.key.trim() !== "" && !isValidEnvVarName(row.key.trim());
                  return (
                     <li key={row.rowId} className="command-form__env-row">
                       <div className="command-form__env-row-controls">
                       <input
                        type="text"
                        className={
                          invalidKey
                            ? "input command-form__env-key input--error"
                            : overridesSystem
                              ? "input command-form__env-key input--warning"
                              : "input command-form__env-key"
                        }
                        value={row.key}
                        onChange={(e) =>
                          updateEnvRow(index, { key: e.target.value })
                        }
                        placeholder={t("commandForm.env.keyPlaceholder", {
                          defaultValue: "KEY",
                        })}
                        aria-label={t("commandForm.env.keyLabel", {
                          defaultValue: "Key",
                        })}
                        aria-invalid={invalidKey || overridesSystem}
                        title={
                          invalidKey
                            ? t("commandForm.env.invalidKey", {
                                defaultValue:
                                  "Invalid name. Use letters, digits and underscore; must not start with a digit.",
                              })
                            : undefined
                        }
                        spellCheck={false}
                      />
                       <input
                         type="text"
                         className="input command-form__env-value"
                         value={row.value}
                         onChange={(e) =>
                           updateEnvRow(index, { value: e.target.value })
                         }
                         placeholder={t("commandForm.env.valuePlaceholder", {
                           defaultValue: "Value",
                         })}
                         aria-label={t("commandForm.env.valueLabel", {
                           defaultValue: "Value",
                         })}
                         spellCheck={false}
                       />
                       <button
                         type="button"
                         className="btn btn--ghost btn--icon command-form__env-remove"
                         onClick={() => handleEnvRowRemove(index)}
                         aria-label={t("commandForm.env.removeRow", {
                           defaultValue: "Remove",
                         })}
                         title={t("commandForm.env.removeRow", {
                           defaultValue: "Remove",
                         })}
                       >
                         <TrashIcon />
                       </button>
                        </div>
                        {overridesSystem && (
                          <p className="command-form__env-override-hint">
                            {t("commandForm.env.overridesSystemValue", {
                              defaultValue:
                                "Overrides system variable. Current value: {{value}}",
                              value: systemVars[row.key.trim()] ?? "",
                            })}
                          </p>
                        )}
                     </li>
                  );
                })}
              </ul>
            ) : (
              <p className="command-form__env-empty">
                {t("commandForm.env.empty", {
                  defaultValue: "No environment variables set for this command.",
                })}
              </p>
            )}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleEnvRowAdd}
            >
              {t("commandForm.env.addRow", { defaultValue: "Add variable" })}
            </button>
          </div>
        </div>

        {/*
         * LiveRunOutput sits OUTSIDE `.command-form__body` so it stays
         * visible regardless of how many fields/hints push the body's
         * scroll. The body scrolls; the output panel and footer are
         * fixed-height siblings under the same flex column. This was
         * the root fix for "терминал не видно при запуске" — embedding
         * the panel inside the scrolling body meant a tall script
         * textarea or sudo-detection hint pushed the panel off-screen.
         *
         * We render the panel only when it has something meaningful to
         * show (any non-idle status, or lines collected) so an empty
         * idle modal doesn't permanently reserve a strip of space at
         * the bottom of the form.
         */}
        {runTarget === "embedded" &&
        (runResult.status !== "idle" || runResult.lines.length > 0) ? (
          <div className="command-form__output-section">
            <LiveRunOutput
              result={runResult}
              collapsed={outputCollapsed}
              onToggleCollapsed={() => setOutputCollapsed((c) => !c)}
              onClear={handleClearOutput}
              t={t}
              envVars={envRowsToRecord(form.envRows)}
            />
          </div>
        ) : null}
      </div>
  );
}

