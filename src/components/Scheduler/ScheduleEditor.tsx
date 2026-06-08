import { useCallback, useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useUIStore } from "../../stores/uiStore";
import { useScheduleStore } from "../../stores/scheduleStore";
import { ScheduleForm } from "./ScheduleForm";

/**
 * Full-screen schedule editor view (`scheduler-editor`). Mirrors the
 * command-editor screen: the target to edit comes from
 * `useUIStore.scheduleEditorTarget` (set by the Scheduler's New / Edit
 * actions before navigating here), and leaving is an explicit navigation
 * back to the Scheduler list rather than a modal dismiss.
 *
 * The schedule to edit is resolved from its id so the form always opens the
 * freshest version from the store (mirrors the command editor's id-based
 * contract). An invalid target (e.g. the schedule was deleted, or a stale
 * route after reload) bounces back to the Scheduler list.
 */
export function ScheduleEditor(): ReactElement | null {
  const target = useUIStore((s) => s.scheduleEditorTarget);
  const schedules = useScheduleStore((s) => s.schedules);
  const setScheduleEditorTarget = useUIStore((s) => s.setScheduleEditorTarget);
  const setView = useUIStore((s) => s.setView);

  // Resolve the schedule to edit from its id so we always render the freshest
  // version. `create` mode resolves to `null` (a blank form).
  const schedule = useMemo(() => {
    if (!target || target.mode === "create" || target.scheduleId === null) {
      return null;
    }
    return schedules.find((s) => s.id === target.scheduleId) ?? null;
  }, [target, schedules]);

  // Guard against an invalid state: the view is active but has no valid
  // target (e.g. the edited schedule was deleted). Bounce back to the
  // Scheduler list so we never show an orphaned editor.
  const targetInvalid =
    target === null ||
    (target.mode === "edit" &&
      (target.scheduleId === null || schedule === null));

  useEffect(() => {
    if (targetInvalid) {
      setScheduleEditorTarget(null);
      setView("scheduler");
    }
  }, [targetInvalid, setScheduleEditorTarget, setView]);

  const handleClose = useCallback((): void => {
    setScheduleEditorTarget(null);
    setView("scheduler");
  }, [setScheduleEditorTarget, setView]);

  if (targetInvalid || target === null) return null;

  return <ScheduleForm schedule={schedule} onClose={handleClose} />;
}
