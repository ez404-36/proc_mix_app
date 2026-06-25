import { useCallback, useState } from "react";

interface UseCanvasModalsArgs {
  /**
   * Whether the draft has unsaved edits. Drives the Close button's guard: a
   * clean draft leaves immediately, a dirty one opens the discard confirm.
   */
  isDirty: boolean;
  /**
   * Effect run when the clear/cancel confirm is accepted (reset the canvas to
   * its saved/fresh state and clear stale run highlighting). The hook closes
   * the dialog itself first.
   */
  onClearConfirmed: () => void;
  /**
   * Navigate away from the editor (to the workflow list). Called immediately
   * for a clean Close, or after the discard confirm is accepted.
   */
  onLeaveEditor: () => void;
}

interface UseCanvasModals {
  /** Whether the clear/cancel destructive confirm dialog is open. */
  clearConfirmOpen: boolean;
  /** Whether the unsaved-changes (Close) discard confirm dialog is open. */
  closeConfirmOpen: boolean;
  /** Open the clear/cancel destructive confirm dialog. */
  openClearConfirm: () => void;
  /** Cancel (close) the clear/cancel confirm dialog without acting. */
  closeClearConfirm: () => void;
  /** Accept the clear/cancel confirm: runs the effect and closes the dialog. */
  confirmClear: () => void;
  /** Close button: leave immediately when clean, else open the discard guard. */
  requestClose: () => void;
  /** Cancel (close) the unsaved-changes discard confirm without leaving. */
  closeCloseConfirm: () => void;
  /** Accept the discard confirm: closes the dialog and leaves the editor. */
  confirmDiscardAndClose: () => void;
}

/**
 * The workflow canvas's two destructive `ConfirmDialog` state machines: the
 * clear-or-cancel confirm and the unsaved-changes Close guard. Owns the
 * open/close flags and exposes the open/close/confirm handlers the JSX wires
 * to, so the component just renders the dialogs from this hook's state. The
 * actual destructive effects (reset, navigate) are supplied by the host via
 * `onClearConfirmed` / `onLeaveEditor` to keep this hook a pure state
 * container. Extracted verbatim from `WorkflowCanvas`.
 */
export function useCanvasModals({
  isDirty,
  onClearConfirmed,
  onLeaveEditor,
}: UseCanvasModalsArgs): UseCanvasModals {
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Unsaved-changes guard shown when Close is clicked with a dirty draft.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const openClearConfirm = useCallback((): void => {
    setClearConfirmOpen(true);
  }, []);
  const closeClearConfirm = useCallback((): void => {
    setClearConfirmOpen(false);
  }, []);

  // Reset the canvas to its initial state, discarding unsaved edits. Delegates
  // the actual reset to the host (`onClearConfirmed`), then closes the dialog.
  const confirmClear = useCallback((): void => {
    onClearConfirmed();
    setClearConfirmOpen(false);
  }, [onClearConfirmed]);

  // Close button: warn about unsaved changes before leaving. A clean draft
  // navigates immediately; a dirty one opens the discard confirmation.
  const requestClose = useCallback((): void => {
    if (isDirty) {
      setCloseConfirmOpen(true);
      return;
    }
    onLeaveEditor();
  }, [isDirty, onLeaveEditor]);

  const closeCloseConfirm = useCallback((): void => {
    setCloseConfirmOpen(false);
  }, []);

  const confirmDiscardAndClose = useCallback((): void => {
    setCloseConfirmOpen(false);
    onLeaveEditor();
  }, [onLeaveEditor]);

  return {
    clearConfirmOpen,
    closeConfirmOpen,
    openClearConfirm,
    closeClearConfirm,
    confirmClear,
    requestClose,
    closeCloseConfirm,
    confirmDiscardAndClose,
  };
}
