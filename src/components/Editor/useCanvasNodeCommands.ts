import { useCallback, useState } from "react";
import {
  deleteCommand as deleteCommandWithHistory,
  promoteCommandToGlobal,
} from "../../services/commandActions";
import type { Command, CommandEditorTarget, View } from "../../types";

interface UseCanvasNodeCommandsArgs {
  /** UI-store action: mark the full-screen command editor clean before opening. */
  setCommandEditorDirty: (dirty: boolean) => void;
  /** UI-store action: target the full-screen command editor (create / edit). */
  setCommandEditorTarget: (target: CommandEditorTarget | null) => void;
  /** UI-store action: navigate to a top-level view. */
  setView: (view: View) => void;
}

interface UseCanvasNodeCommands {
  /**
   * The local command shown in the read-only `CommandView` modal (opened by
   * clicking an item in the palette's "Local commands" list), or `null`.
   */
  viewCommand: Command | null;
  /**
   * `true` while the promote-to-global confirm dialog is open (a command is
   * staged for promotion). The dialog renders against this flag.
   */
  promotePendingOpen: boolean;
  /** Open a local command in the read-only `CommandView` modal. */
  onViewLocalCommand: (command: Command) => void;
  /** Close the `CommandView` modal. */
  closeViewCommand: () => void;
  /** Edit a local command from its `CommandView` (returns to the editor). */
  onEditViewedCommand: (command: Command) => void;
  /** Delete a local command from its `CommandView` (history-logged). */
  onDeleteViewedCommand: (command: Command) => void;
  /** Request promotion of a local command to global (opens the confirm). */
  onPromoteCommand: (commandId: string) => void;
  /** Confirm the staged promotion. */
  confirmPromote: () => void;
  /** Cancel the staged promotion. */
  cancelPromote: () => void;
}

/**
 * The local-command sub-flows reachable from the workflow canvas's palette
 * "Local commands" list and the read-only `CommandView` modal: viewing,
 * editing, deleting, and promoting a workflow-local command to global. Owns
 * the `viewCommand` modal target and the `promotePendingId` confirm state,
 * returning the handlers the JSX wires to. Extracted verbatim from
 * `WorkflowCanvas` to keep that component a thin composition point.
 */
export function useCanvasNodeCommands({
  setCommandEditorDirty,
  setCommandEditorTarget,
  setView,
}: UseCanvasNodeCommandsArgs): UseCanvasNodeCommands {
  // The local command shown in the read-only CommandView modal (opened by
  // clicking an item in the palette's "Local commands" list), or `null`.
  const [viewCommand, setViewCommand] = useState<Command | null>(null);
  // A command staged for promotion to global: the promote confirm dialog is
  // open while this is non-null (set from the CommandView "Make global" button
  // or the node inspector promote action). `null` when no confirm is pending.
  const [promotePendingId, setPromotePendingId] = useState<string | null>(null);

  // Open a local command in the read-only CommandView modal (clicking an item
  // in the "Local commands" list). These items do not add a node — that is
  // done via the empty "Command" node + its picker.
  const onViewLocalCommand = useCallback((command: Command): void => {
    setViewCommand(command);
  }, []);

  const closeViewCommand = useCallback((): void => {
    setViewCommand(null);
  }, []);

  // Edit a local command from its CommandView: open the full-screen command
  // editor, returning to THIS workflow editor on close (so the user lands back
  // on the workflow). Mirrors the Library edit flow plus the `returnTo` hint.
  const onEditViewedCommand = useCallback(
    (command: Command): void => {
      setViewCommand(null);
      setCommandEditorDirty(false);
      setCommandEditorTarget({
        mode: "edit",
        commandId: command.id,
        returnTo: "editor",
      });
      setView("command-editor");
    },
    [setCommandEditorDirty, setCommandEditorTarget, setView],
  );

  // Delete a local command from its CommandView (history-logged, restorable).
  const onDeleteViewedCommand = useCallback((command: Command): void => {
    setViewCommand(null);
    deleteCommandWithHistory(command.id);
  }, []);

  // Request promotion of a local command to global ("make global"): opens the
  // confirm dialog. The actual promote happens on confirm. Used by the
  // CommandView "Make global" button (opened from the Local commands list).
  const onPromoteCommand = useCallback((commandId: string): void => {
    setPromotePendingId(commandId);
  }, []);

  // Confirm/cancel the promote. On confirm the command leaves this workflow's
  // private scope and joins the shared library (renamed on name conflict — see
  // `promoteCommandToGlobal`); it then disappears from the "Local commands"
  // list and the open CommandView (no longer local) is closed.
  const confirmPromote = useCallback((): void => {
    if (promotePendingId !== null) {
      promoteCommandToGlobal(promotePendingId);
    }
    setPromotePendingId(null);
    setViewCommand(null);
  }, [promotePendingId]);

  const cancelPromote = useCallback((): void => {
    setPromotePendingId(null);
  }, []);

  return {
    viewCommand,
    promotePendingOpen: promotePendingId !== null,
    onViewLocalCommand,
    closeViewCommand,
    onEditViewedCommand,
    onDeleteViewedCommand,
    onPromoteCommand,
    confirmPromote,
    cancelPromote,
  };
}
