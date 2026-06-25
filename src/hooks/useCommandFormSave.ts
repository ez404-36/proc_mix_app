import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  createCommand as createCommandWithHistory,
  updateCommand as updateCommandWithHistory,
} from "../services/commandActions";
import { detectAdminEscalation } from "../utils/detectAdminEscalation";
import { normalizeTags } from "../utils/commandFilters";
import {
  envRowsToRecord,
  parseTimeoutSeconds,
  rowsToVariableSpecs,
} from "../utils/commandFormState";
import type {
  Command,
  CommandScope,
  VariableSpec,
} from "../types";
import type { FormErrors, FormState, FormTab } from "../types/commandForm";

export interface UseCommandFormSaveParams {
  form: FormState;
  mode: "create" | "edit";
  command: Command | null;
  errors: FormErrors;
  hasErrors: boolean;
  hasVariableErrors: boolean;
  setShowErrors: Dispatch<SetStateAction<boolean>>;
  setActiveTab: Dispatch<SetStateAction<FormTab>>;
  initialScope?: CommandScope;
  initialWorkflowId?: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Cancel any in-flight live-run before the save closes the form. */
  cancelActiveRunForSave: () => void;
  /** Tear down all live-run state once the save has navigated away. */
  teardownRun: () => void;
}

export interface UseCommandFormSaveResult {
  /**
   * Validate, assemble the create/edit DTO, persist via the history-aware
   * command actions, then clear the dirty flag and close the form. When
   * validation fails it reveals the errors and jumps to the first
   * offending tab instead of saving.
   */
  handleSave: () => void;
}

/**
 * Encapsulates the command form's save path: validation gating, the
 * create-vs-edit DTO assembly (byte-identical wire shape to before), the
 * defensive admin re-detection, and the post-save teardown/close.
 *
 * Extracted verbatim from CommandForm so the container stays a thin
 * composition of focused hooks (SRP). The form remains the state owner —
 * this hook only reads the current `form`/`mode`/`command` and the derived
 * error flags, and calls back out through the supplied setters/callbacks.
 */
export function useCommandFormSave(
  params: UseCommandFormSaveParams,
): UseCommandFormSaveResult {
  const {
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
  } = params;

  // History-aware wrappers — see services/commandActions.ts. The
  // wrappers delegate to the same store methods, so existing test
  // spies that replace `useCommandStore.getState().addCommand` keep
  // working as long as the spy returns a `Command`-shaped value.
  const addCommand = createCommandWithHistory;
  const updateCommand = updateCommandWithHistory;

  const handleSave = useCallback((): void => {
    if (hasErrors) {
      setShowErrors(true);
      // Jump to the first tab carrying an error so the user sees it even
      // if they're on a different tab. Name (main) takes precedence over
      // script/variables (script).
      if (errors.name !== undefined || errors.apiSlug !== undefined) {
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
    // Remote runs cannot be elevated in this version (local sudo/UAC does
    // not map onto a remote host). Force the persisted flag off for a remote
    // target so a command can't be saved as "remote + admin" — a combination
    // the executor would reject. The UI also disables the toggle for remote.
    const isRemoteTarget = form.target.kind !== "local";
    const runAsAdminValue =
      !isRemoteTarget &&
      (form.runAsAdmin || detectAdminEscalation(trimmedScript));

    // Persisted target: omit it entirely when local so the saved Command's
    // wire shape stays byte-identical to a command that predates this feature
    // (the executor defaults a missing target to local).
    const targetValue =
      form.target.kind === "local" ? undefined : form.target;

    // Persist the password-prompt opt-in only for a remote target — it is
    // meaningless for a local run. Switching a command back to local therefore
    // drops the flag, so it can't silently re-arm if the command later becomes
    // remote again.
    const promptSshPasswordValue =
      isRemoteTarget && form.promptSshPassword ? true : undefined;

    // HTTP-API fields. A blank slug means "no slug" (stored as undefined). The
    // slug is only meaningful when API access is enabled, but we persist the
    // typed value regardless so toggling access off then on keeps the slug.
    const trimmedSlug = form.apiSlug.trim();
    const apiSlugValue = trimmedSlug === "" ? undefined : trimmedSlug;

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
        // Explicit field (including `undefined`) so switching a remote command
        // back to local drops the stored target rather than leaving the old
        // value behind the store's spread merge.
        target: targetValue,
        // Explicit field so unchecking (or switching to local) drops the flag.
        promptSshPassword: promptSshPasswordValue,
        // HTTP API: explicit fields (including `undefined` slug) so clearing
        // the slug or disabling access drops the value on the stored command.
        apiEnabled: form.apiEnabled,
        apiSlug: apiSlugValue,
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
        ...(targetValue !== undefined ? { target: targetValue } : {}),
        ...(promptSshPasswordValue !== undefined
          ? { promptSshPassword: promptSshPasswordValue }
          : {}),
        // HTTP API: omit entirely when not opted in / no slug so the wire stays
        // byte-identical to a command that predates this feature.
        ...(form.apiEnabled ? { apiEnabled: true } : {}),
        ...(apiSlugValue !== undefined ? { apiSlug: apiSlugValue } : {}),
        // A command created from within a workflow editor is scoped LOCAL to
        // that workflow (hidden from the global library). Stamp the scope +
        // owning workflow id supplied by the host. Omitted entirely for a
        // normal global create so the wire stays byte-identical.
        ...(initialScope === "local" && initialWorkflowId !== undefined
          ? { scope: "local" as const, workflowId: initialWorkflowId }
          : {}),
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
    form.target,
    form.promptSshPassword,
    form.apiEnabled,
    form.apiSlug,
    errors,
    hasErrors,
    hasVariableErrors,
    mode,
    onClose,
    onDirtyChange,
    cancelActiveRunForSave,
    teardownRun,
    updateCommand,
    initialScope,
    initialWorkflowId,
    setShowErrors,
    setActiveTab,
  ]);

  return { handleSave };
}
