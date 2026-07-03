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
  CommandScope,
  OutputSchema,
  Shell,
  VariableSpec,
} from "../../types";
import { getCachedPlatform } from "../../utils/platform";
import { getCachedAvailableShells } from "../../utils/shells";
import { parseUtilityNamesWithRanges } from "../../utils/utilityName";
import type { UtilityNameRange } from "../../utils/utilityName";
import { useUtilitiesHelp } from "../../hooks/useUtilityHelp";
import { useAdminEscalation } from "../../hooks/useAdminEscalation";
import { useCommandLiveRun } from "../../hooks/useCommandLiveRun";
import { useCommandFormSave } from "../../hooks/useCommandFormSave";
import { useEnvRows } from "../../hooks/useEnvRows";
import { useVariableRows } from "../../hooks/useVariableRows";
import { useUtilityFlagBuilder } from "../../hooks/useUtilityFlagBuilder";
import { MainTab } from "./MainTab";
import { ScriptTab } from "./ScriptTab";
import { OutputTab } from "./OutputTab";
import { EnvTab } from "./EnvTab";
import { ExplorerTab } from "./ExplorerTab";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useCommandStore } from "../../stores/commandStore";
import { isValidApiSlug } from "../../utils/apiSlug";
import { CancelIcon, RunIcon, SaveIcon } from "../icons";
import { IdBadge } from "../IdBadge";
import type { DropdownOption } from "../Dropdown";
import { LiveRunOutput } from "./LiveRunOutput";
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
  rowsToVariableSpecs,
} from "./formState";
import type {
  FormErrors,
  FormState,
  FormTab,
} from "./formState";
import {
  getCachedProcessEnv,
  getProcessEnv,
} from "../../services/environmentService";

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
  /**
   * Scope to stamp on a command created from this form. `"local"` (paired
   * with {@link initialWorkflowId}) is passed when the create flow is
   * launched from a workflow editor; the resulting command is hidden from the
   * global library. Defaults to a global command when omitted. Ignored in
   * edit mode (a command's scope is changed via the promote action).
   */
  initialScope?: CommandScope;
  /**
   * Owning workflow id for a `"local"` create. Required when
   * {@link initialScope} is `"local"`. Ignored otherwise.
   */
  initialWorkflowId?: string;
}

/**
 * Full-screen form for creating and editing user commands.
 *
 * Behaviour:
 *   - Esc cancels
 *   - Backdrop click cancels
 *   - Cmd/Ctrl+Enter saves (when validation passes)
  *   - Save button label is "Save" in both create and edit mode
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
    initialScope,
    initialWorkflowId,
  } = props;
  const { t } = useTranslation();
  // Resolve the owning workflow's name for a local create so the form
  // header can read `New command (workflow "…")`. Selecting the stable
  // `workflows` array (not an inline `.find`) keeps the selector
  // referentially stable; the lookup itself is a cheap render-time step.
  const workflows = useWorkflowStore((s) => s.workflows);
  // All commands, used to detect an API-slug collision client-side before save
  // (the backend's partial unique index is the ultimate guard). Referentially
  // stable selector; the lookup itself is a cheap render-time step.
  const allCommands = useCommandStore((s) => s.commands);

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
    // Validate the API slug only when API access is ON and a slug is entered
    // (blank = "no slug", which is valid). When the opt-in is off the slug
    // field is hidden, so validating it would surface an error the user can't
    // see/fix — and the slug isn't persisted in that case anyway. First the
    // character set, then a per-type uniqueness check against other commands.
    const slug = form.apiSlug.trim();
    if (form.apiEnabled && slug !== "") {
      if (!isValidApiSlug(slug)) {
        next.apiSlug = t("commandForm.httpApi.slugInvalid");
      } else {
        const conflict = allCommands.some(
          (c) => c.id !== command?.id && c.apiSlug === slug,
        );
        if (conflict) {
          next.apiSlug = t("commandForm.httpApi.slugConflict");
        }
      }
    }
    return next;
  }, [
    form.name,
    form.script,
    form.apiEnabled,
    form.apiSlug,
    allCommands,
    command?.id,
    t,
  ]);

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
    errors.apiSlug !== undefined ||
    hasVariableErrors;

  // Which tab each validation error belongs to, so the tab strip can show
  // an error badge and Save can jump to the first offending tab. The
  // output tab has no validation today. The HTTP API section lives on the
  // main tab, so a slug error flags the main tab.
  const mainTabHasError =
    errors.name !== undefined || errors.apiSlug !== undefined;
  const scriptTabHasError =
    errors.script !== undefined || hasVariableErrors;

  // Save path: validation gating + create/edit DTO assembly + teardown.
  // Extracted to a hook so the container stays a thin composition (SRP).
  const { handleSave } = useCommandFormSave({
    form,
    mode,
    command,
    errors,
    hasErrors,
    hasVariableErrors,
    setShowErrors,
    setActiveTab,
    initialScope,
    initialWorkflowId,
    onClose,
    onDirtyChange,
    cancelActiveRunForSave,
    teardownRun,
  });

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
  // EVERY command's utility (the leading one PLUS every command after a
  // `|`/`;`/`&&`/`||`/`&` separator), each with its position — so the
  // editor highlights and offers `--help` hints for `grep` in
  // `ls | grep foo`, not just the leading `ls`.
  const utilityRanges = useMemo<UtilityNameRange[]>(
    () =>
      form.disableHints ? [] : parseUtilityNamesWithRanges(form.script),
    [form.script, form.disableHints],
  );
  // The leading utility drives the (single-utility) flag-builder panel.
  const utilityRange = utilityRanges[0] ?? null;

  // Resolve help for every recognised utility name at once (debounced,
  // cached). Returns a map of name → resolved help (absent while loading).
  const utilityNames = useMemo<string[]>(
    () => utilityRanges.map((r) => r.name),
    [utilityRanges],
  );
  const helpByUtility = useUtilitiesHelp(utilityNames);

  // Resolved help for the LEADING utility — drives the flag-builder button
  // and panel (a single-utility feature). `null` while still loading.
  const resolvedHelp = utilityRange
    ? helpByUtility.get(utilityRange.name) ?? null
    : null;

  // Highlight descriptors for the editor overlay: one per command, each
  // with its offsets and a colour status from its resolved lookup. While
  // a lookup is idle/loading the status is "pending" so the token renders
  // WITHOUT a green/red colour (avoids a flash before the answer arrives).
  const utilityHighlights = useMemo<UtilityHighlight[]>(() => {
    return utilityRanges.map((range) => {
      const help = helpByUtility.get(range.name) ?? null;
      const status: UtilityHighlightStatus =
        help === null
          ? "pending"
          : help.status === "found"
            ? "found"
            : "not-found";
      return {
        name: range.name,
        start: range.start,
        end: range.end,
        status,
      };
    });
  }, [utilityRanges, helpByUtility]);

  // Flag-builder concerns (open/loading state, on-demand + proactive
  // ParsedCli fetch/prune, panel sync) — extracted to useUtilityFlagBuilder
  // (SRP). The form remains the state owner; the hook calls back through
  // `setForm` only when the user applies a builder edit.
  const {
    flagBuilderOpen,
    flagBuilderData,
    flagBuilderLoading,
    flagsByUtility,
    handleOpenFlagBuilder,
    handleFlagBuilderChange,
    handleFlagBuilderDismiss,
  } = useUtilityFlagBuilder({
    utilityRanges,
    helpByUtility,
    resolvedHelp,
    utilityRange,
    setForm,
  });

  // Variable-row CRUD — extracted to useVariableRows (SRP). The form
  // remains the state owner; the hook only wraps the `setForm` updates.
  const { handleVariableAdd, handleVariableRemove, updateVariableRow } =
    useVariableRows(setForm);

  const handleOutputSchemaChange = useCallback(
    (next: OutputSchema | undefined): void => {
      setForm((s) => ({ ...s, outputSchema: next }));
    },
    [],
  );

  // Env-row CRUD — extracted to useEnvRows (SRP).
  const { handleEnvRowAdd, handleEnvRowRemove, updateEnvRow } =
    useEnvRows(setForm);

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

  // For a local create launched from a workflow editor, scope the header to
  // the owning workflow: `New command (workflow "<name>")`. Falls back to the
  // plain create title if the workflow can't be resolved.
  const localWorkflowName =
    mode === "create" && initialScope === "local" && initialWorkflowId
      ? (workflows.find((w) => w.id === initialWorkflowId)?.name ?? null)
      : null;
  const title =
    mode === "create"
      ? localWorkflowName !== null
        ? t("commandForm.title.createLocal", { workflow: localWorkflowName })
        : t("commandForm.title.create")
      : t("commandForm.title.edit");
  const saveLabel = t("commandForm.actions.save");

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

  // Remote runs can't be elevated in this version (local sudo/UAC doesn't map
  // onto a remote host). When the target is remote, the admin checkbox is
  // disabled + force-unchecked and a hint explains why. The save path also
  // forces `runAsAdmin` off for a remote target.
  const isRemoteTarget = form.target.kind !== "local";
  // Elevation is locked when the script auto-escalates (existing behaviour)
  // OR when the target is remote (new). Both render the checkbox disabled.
  const elevationLocked = escalationDetected || isRemoteTarget;

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
          <div className="command-form__topbar-heading">
            <h1 className="command-form__topbar-title">{title}</h1>
            {mode === "edit" && command !== null ? (
              <IdBadge id={command.id} />
            ) : null}
          </div>
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
              { key: "env", hasError: false },
              { key: "script", hasError: scriptTabHasError },
              { key: "output", hasError: false },
              { key: "explorer", hasError: false },
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
          <MainTab
            t={t}
            active={activeTab === "main"}
            form={form}
            errors={errors}
            showErrors={showErrors}
            nameInputRef={nameInputRef}
            onNameChange={handleNameChange}
            onDescriptionChange={handleDescriptionChange}
            tagDraft={tagDraft}
            setTagDraft={setTagDraft}
            filteredTagSuggestions={filteredTagSuggestions}
            tagSuggestActiveIndex={tagSuggestActiveIndex}
            setTagSuggestActiveIndex={setTagSuggestActiveIndex}
            onTagInputKeyDown={handleTagInputKeyDown}
            commitTag={commitTag}
            onRemoveTag={handleRemoveTag}
            addingCategory={addingCategory}
            newCategoryDraft={newCategoryDraft}
            setNewCategoryDraft={setNewCategoryDraft}
            categoryOptions={categoryOptions}
            onCategorySelect={handleCategorySelect}
            onCategoryAddConfirm={handleCategoryAddConfirm}
            onCategoryAddCancel={handleCategoryAddCancel}
            onApiEnabledChange={(next) =>
              setForm((s) => ({ ...s, apiEnabled: next }))
            }
            onApiSlugChange={(next) =>
              setForm((s) => ({ ...s, apiSlug: next }))
            }
          />

          <ScriptTab
            t={t}
            active={activeTab === "script"}
            form={form}
            setForm={setForm}
            errors={errors}
            showErrors={showErrors}
            platform={platform}
            scriptVariableSpecs={scriptVariableSpecs}
            utilityHighlights={utilityHighlights}
            helpByUtility={helpByUtility}
            utilityRanges={utilityRanges}
            flagsByUtility={flagsByUtility}
            resolvedHelp={resolvedHelp}
            flagBuilderOpen={flagBuilderOpen}
            flagBuilderData={flagBuilderData}
            flagBuilderLoading={flagBuilderLoading}
            onOpenFlagBuilder={handleOpenFlagBuilder}
            onFlagBuilderChange={handleFlagBuilderChange}
            onFlagBuilderDismiss={handleFlagBuilderDismiss}
            isRemoteTarget={isRemoteTarget}
            elevationLocked={elevationLocked}
            escalationDetected={escalationDetected}
            adminPasswordStored={adminPasswordStored}
            variableErrors={variableErrors}
            onVariableAdd={handleVariableAdd}
            onVariableRemove={handleVariableRemove}
            updateVariableRow={updateVariableRow}
          />

          <OutputTab
            t={t}
            active={activeTab === "output"}
            value={form.outputSchema}
            onChange={handleOutputSchemaChange}
            sampleOutput={runStdoutSample}
          />

          <EnvTab
            t={t}
            active={activeTab === "env"}
            form={form}
            onTargetChange={(target) => setForm((s) => ({ ...s, target }))}
            onPromptSshPasswordChange={(promptSshPassword) =>
              setForm((s) => ({ ...s, promptSshPassword }))
            }
            shellOptions={shellOptions}
            showNoShellsWarning={showNoShellsWarning}
            onShellChange={handleShellChange}
            onWorkingDirChange={(value) =>
              setForm((s) => ({ ...s, workingDir: value }))
            }
            onPromptWorkingDirChange={(next) =>
              setForm((s) => ({ ...s, promptWorkingDir: next }))
            }
            systemVars={systemVars}
            onEnvRowAdd={handleEnvRowAdd}
            onEnvRowRemove={handleEnvRowRemove}
            updateEnvRow={updateEnvRow}
          />

          <ExplorerTab
            t={t}
            active={activeTab === "explorer"}
            form={form}
            onExplorerEnabledChange={(next) =>
              setForm((s) => ({ ...s, explorerEnabled: next }))
            }
            onExplorerPathVariableChange={(next) =>
              setForm((s) => ({ ...s, explorerPathVariable: next }))
            }
          />
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
