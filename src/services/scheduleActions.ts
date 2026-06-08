// Service layer over `scheduleStore` for the Scheduler UI.
//
// UI code (the Scheduler tab + schedule form) MUST call these helpers instead
// of touching the store or `invoke` directly. They translate the backend's
// typed error sentinels (`INVALID_CRON`) into a discriminated result the form
// can react to, and surface unexpected failures as a toast.
//
// The helpers are pure functions (not hooks) so they can be invoked from
// anywhere — event handlers, effects, even outside React.

import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useScheduleStore } from "../stores/scheduleStore";
import type { NewScheduleInput, Schedule } from "../types";
import { runScheduleNowInDb } from "../utils/scheduleRepository";

/**
 * Outcome of a create / update attempt. `ok` carries the materialised
 * schedule; the error variants let the form show a targeted message
 * (upgrade prompt for quota, inline error for a bad cron) without parsing
 * raw strings at the call site.
 */
export type ScheduleSaveResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; reason: "invalidCron" | "unknown" };

/** Extract a comparable error code from an unknown thrown value. */
function errorCode(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

function classify(err: unknown): ScheduleSaveResult {
  const code = errorCode(err);
  if (code.includes("INVALID_CRON")) {
    return { ok: false, reason: "invalidCron" };
  }
  console.error("schedule save failed", err);
  Message.error(
    i18n.t("scheduler.saveFailed", {
      defaultValue: "Failed to save the schedule",
    }),
  );
  return { ok: false, reason: "unknown" };
}

/** Create a new schedule. */
export async function createSchedule(
  input: NewScheduleInput,
): Promise<ScheduleSaveResult> {
  try {
    const schedule = await useScheduleStore.getState().addSchedule(input);
    return { ok: true, schedule };
  } catch (err: unknown) {
    return classify(err);
  }
}

/** Patch an existing schedule. */
export async function updateSchedule(
  id: string,
  patch: Partial<Schedule>,
): Promise<ScheduleSaveResult> {
  try {
    const schedule = await useScheduleStore
      .getState()
      .updateSchedule(id, patch);
    return { ok: true, schedule };
  } catch (err: unknown) {
    return classify(err);
  }
}

/**
 * Enable / disable a schedule. Failures surface as a toast but are not
 * propagated — toggling is a low-stakes action and the next hydrate will
 * reconcile the displayed state.
 */
export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  try {
    await useScheduleStore.getState().setEnabled(id, enabled);
  } catch (err: unknown) {
    console.error("failed to toggle schedule", id, err);
    Message.error(
      i18n.t("scheduler.saveFailed", {
        defaultValue: "Failed to save the schedule",
      }),
    );
  }
}

/**
 * Manually fire a schedule's target now (out of band — does not affect the
 * cron timing or the schedule's stats). Surfaces success / failure as a toast.
 */
export async function runScheduleNow(id: string): Promise<void> {
  try {
    await runScheduleNowInDb(id);
    Message.success(
      i18n.t("scheduler.runNowStarted", {
        defaultValue: "Schedule run started",
      }),
    );
  } catch (err: unknown) {
    console.error("failed to run schedule now", id, err);
    Message.error(
      i18n.t("scheduler.runNowFailed", {
        defaultValue: "Failed to run the schedule",
      }),
    );
  }
}

/** Delete a schedule. Failures surface as a toast. */
export async function deleteSchedule(id: string): Promise<void> {
  try {
    await useScheduleStore.getState().removeSchedule(id);
  } catch (err: unknown) {
    console.error("failed to delete schedule", id, err);
    Message.error(
      i18n.t("scheduler.saveFailed", {
        defaultValue: "Failed to delete the schedule",
      }),
    );
  }
}
