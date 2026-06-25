import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import {
  clearAdminPassword,
  hasAdminPassword,
  setAdminPassword,
} from "../../utils/adminPassword";
import { promptForAdminPassword } from "../../utils/adminPasswordPrompt";
import { getCachedPlatform } from "../../utils/platform";

interface AdminPasswordSection {
  isWindows: boolean;
  adminPasswordStored: boolean;
  handleSetAdminPassword: () => Promise<void>;
  handleClearAdminPassword: () => Promise<void>;
}

/**
 * Owns the Administrator-privileges section state and actions.
 *
 * `adminPasswordStored` mirrors what the Rust keychain says about
 * the stored sudo password — we DON'T read the value, just whether
 * anything is there. The status is refreshed on mount and after
 * every set/clear so the buttons reflect reality without the user
 * having to reload.
 *
 * On Windows the whole section is informational because UAC handles
 * auth at OS level — there's nothing for us to store or clear.
 */
export function useAdminPasswordSection(): AdminPasswordSection {
  const { t } = useTranslation();
  const platform = getCachedPlatform();
  const isWindows = platform === "windows";
  const [adminPasswordStored, setAdminPasswordStored] = useState<boolean>(false);

  const refreshAdminPasswordStatus = useCallback(async (): Promise<void> => {
    try {
      const value = await hasAdminPassword();
      setAdminPasswordStored(value);
    } catch {
      // Keychain unavailable — treat as "not stored" so the UI shows
      // the Set button. Attempting to set will surface the real
      // backend error via the Message.error toast below.
      setAdminPasswordStored(false);
    }
  }, []);

  useEffect(() => {
    void refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus]);

  const handleSetAdminPassword = useCallback(async (): Promise<void> => {
    // The Settings "Set password" flow is explicitly about persisting,
    // so we ignore the prompt's `remember` flag here: whichever button
    // the user clicked, the entered value is saved to the OS keychain.
    // The triggerCommandRun flow is what differentiates between save
    // and one-shot — this entry point has no other reason to exist.
    const result = await promptForAdminPassword();
    if (result === null) return; // user cancelled — no toast
    try {
      await setAdminPassword(result.password);
      Message.success(
        t("settings.admin.setSuccess", {
          defaultValue: "Administrator password saved",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("settings.admin.setError", {
          defaultValue: "Failed to save password",
        })}: ${msg}`,
      );
    }
    await refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus, t]);

  const handleClearAdminPassword = useCallback(async (): Promise<void> => {
    try {
      await clearAdminPassword();
      Message.success(
        t("settings.admin.clearSuccess", {
          defaultValue: "Administrator password cleared",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("settings.admin.clearError", {
          defaultValue: "Failed to clear password",
        })}: ${msg}`,
      );
    }
    await refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus, t]);

  return {
    isWindows,
    adminPasswordStored,
    handleSetAdminPassword,
    handleClearAdminPassword,
  };
}
