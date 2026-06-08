import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { hasAdminPassword } from "../utils/adminPassword";
import { detectAdminEscalation } from "../utils/detectAdminEscalation";
import type { FormState } from "../types/commandForm";

export interface UseAdminEscalationResult {
  /**
   * Cached "is a sudo password stored in the keychain" flag, used to
   * decide whether to show the "you'll be asked on first run" hint under
   * the Run-as-admin checkbox. `setAdminPasswordStored` is exposed so the
   * live-run flow can refresh it immediately after persisting (or failing
   * to persist) a password.
   */
  adminPasswordStored: boolean;
  setAdminPasswordStored: Dispatch<SetStateAction<boolean>>;
  /**
   * True when the script's leading line escalates inline (sudo / doas /
   * pkexec). When detected the checkbox is forced on and locked so the
   * persisted `runAsAdmin` value cannot disagree with what the script does.
   */
  escalationDetected: boolean;
}

/**
 * Owns the Run-as-administrator escalation concerns for the command form:
 *   1. The cached "password stored?" flag (refreshed on mount and whenever
 *      the user toggles `runAsAdmin`).
 *   2. Inline-escalation auto-detection, which force-enables `runAsAdmin`
 *      when the script begins with `sudo`/`doas`/`pkexec`.
 *
 * Extracted verbatim from CommandForm so the form container stays a thin
 * composition of focused hooks (SRP).
 */
export function useAdminEscalation(
  form: FormState,
  setForm: Dispatch<SetStateAction<FormState>>,
): UseAdminEscalationResult {
  // Cached "is a password stored" flag used to decide whether to show
  // the "you'll be asked on first run" hint under the checkbox. We
  // refresh it on mount and whenever the user toggles the checkbox so
  // the hint disappears immediately after the user goes through the
  // first elevated run. The Promise rejecting (keychain unavailable)
  // is treated as `false` — the worst case is that the hint shows
  // even though the password is technically stored, which is harmless.
  const [adminPasswordStored, setAdminPasswordStored] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    hasAdminPassword()
      .then((value) => {
        if (!cancelled) setAdminPasswordStored(value);
      })
      .catch(() => {
        if (!cancelled) setAdminPasswordStored(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.runAsAdmin]);

  // Auto-detect inline escalation (sudo / doas / pkexec at the start
  // of the script). When detected we force the admin flag on AND
  // disable the checkbox so the persisted runAsAdmin value can't
  // disagree with what the script body actually does. Removing sudo
  // from the script lets the user toggle the checkbox again.
  //
  // The detector runs on every keystroke in the script field. It's a
  // single linear pass over the leading lines and well under 1µs for
  // typical script sizes — memoising would add more code than it saves.
  const escalationDetected = detectAdminEscalation(form.script);
  useEffect(() => {
    if (escalationDetected && !form.runAsAdmin) {
      setForm((s) => ({ ...s, runAsAdmin: true }));
    }
    // Intentionally do NOT auto-uncheck when the detector flips back to
    // false: the user may have explicitly ticked the checkbox for a
    // script that escalates internally (e.g. inside a function). The
    // checkbox becomes re-editable, but its current value stays.
  }, [escalationDetected, form.runAsAdmin, setForm]);

  return { adminPasswordStored, setAdminPasswordStored, escalationDetected };
}
