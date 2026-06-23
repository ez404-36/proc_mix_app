import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import type { ExecutionTarget } from "../../types";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import {
  selectCheckState,
  useSshHostStore,
} from "../../stores/sshHostStore";
import type { HostCheckState } from "../../stores/sshHostStore";
import { getCachedPlatform } from "../../utils/platform";
import {
  clearSshPassword,
  hasSshPassword,
  setSshPassword,
} from "../../services/sshConnectionService";

/** The three target modes the selector exposes, as stable option values. */
const MODE_LOCAL = "local";
const MODE_REMOTE = "remote";
const MODE_PROMPT = "remotePrompt";

/**
 * Hoisted stable "idle" reference for the no-host-selected case. A zustand
 * selector MUST return a referentially-stable value for unchanged state —
 * returning a fresh `{ kind: 'idle' }` literal each render would defeat
 * `Object.is` and spin an infinite render loop.
 */
const IDLE_CHECK_STATE: HostCheckState = { kind: "idle" };

export interface TargetSelectorProps {
  value: ExecutionTarget;
  onChange: (next: ExecutionTarget) => void;
  /**
   * When true, the runner prompts for a one-shot SSH password before each
   * remote run (the host uses password auth, not keys). Only meaningful for a
   * remote target; the checkbox is hidden for local.
   */
  promptSshPassword: boolean;
  onPromptSshPasswordChange: (next: boolean) => void;
}

/**
 * "Where to run" selector for the command form's Main tab.
 *
 * A mode dropdown (Local / Remote host / Ask at run time) plus, for the
 * "Remote host" mode, a host dropdown sourced from the SAME `useSshHostStore`
 * the Environment → Connections tab renders — so the offered hosts always
 * match that inventory exactly. A "Check" button probes the selected host's
 * reachability (reusing the store's `check` action).
 *
 * Remote execution in this version does not apply the command's working
 * directory or env, and cannot be elevated; the hints below say so.
 */
export function TargetSelector({
  value,
  onChange,
  promptSshPassword,
  onPromptSshPasswordChange,
}: TargetSelectorProps): ReactElement {
  const { t } = useTranslation();

  // Same store + array the Connections tab uses. `hosts` excludes wildcard
  // patterns (those live in `patterns`) and errored sources, so the list is
  // exactly the connectable inventory.
  const hosts = useSshHostStore((s) => s.hosts);
  const isLoading = useSshHostStore((s) => s.isLoading);
  const load = useSshHostStore((s) => s.load);
  const check = useSshHostStore((s) => s.check);

  // Populate the inventory once when the selector first needs it. Loading is
  // idempotent in the store; we only kick it off when the list is still empty
  // so re-opening the form doesn't refetch needlessly.
  useEffect(() => {
    if (hosts.length === 0) {
      void load();
    }
    // Run on mount; `load`/`hosts.length` are stable enough for this guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = value.kind;
  const selectedAlias = value.kind === "remote" ? value.alias : "";

  // Password auth is Unix-only: the askpass transport (SSH_ASKPASS + throwaway
  // keychain) is unreliable on Win32-OpenSSH, so the executor ignores a remote
  // password on Windows. Hide the opt-in there entirely rather than offer a
  // control that silently does nothing — Windows users authenticate with keys.
  const isWindows = getCachedPlatform() === "windows";

  // Keep the opt-in consistent with where its checkbox is shown: clear it when
  // the target is local or when password auth is unavailable (Windows). Without
  // this, a command saved with the flag on Unix would carry a dangling
  // `promptSshPassword` after being edited on Windows or switched to local.
  useEffect(() => {
    if (promptSshPassword && (mode === "local" || isWindows)) {
      onPromptSshPasswordChange(false);
    }
  }, [promptSshPassword, mode, isWindows, onPromptSshPasswordChange]);

  // ---- Persistent per-host SSH password (Phase 2) -------------------------
  // A saved password lets a password host run unattended (no run-time prompt).
  // It is keyed by the concrete selected alias, so it is only meaningful for a
  // "Remote host" target with a chosen host, on Unix. The value never reaches
  // the frontend — we only learn whether one exists and can set/clear it.
  const passwordHostAlias =
    mode === "remote" && selectedAlias !== "" ? selectedAlias : "";
  const canManagePassword = !isWindows && passwordHostAlias !== "";

  const [passwordStored, setPasswordStored] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  // Refresh the "is a password saved?" indicator whenever the manageable host
  // changes. A read failure (keychain unavailable) is treated as "not saved"
  // rather than surfaced — the user can still attempt to set one, which will
  // report the real error. Guard against a late resolve after the alias
  // changed by capturing the alias the effect ran for.
  useEffect(() => {
    if (!canManagePassword) {
      setPasswordStored(false);
      setEditingPassword(false);
      setPasswordInput("");
      return;
    }
    let active = true;
    void hasSshPassword(passwordHostAlias)
      .then((stored) => {
        if (active) setPasswordStored(stored);
      })
      .catch(() => {
        if (active) setPasswordStored(false);
      });
    return () => {
      active = false;
    };
  }, [canManagePassword, passwordHostAlias]);

  const handleSavePassword = useCallback(async (): Promise<void> => {
    if (passwordInput === "" || passwordHostAlias === "") return;
    setPasswordBusy(true);
    try {
      await setSshPassword(passwordHostAlias, passwordInput);
      setPasswordStored(true);
      setEditingPassword(false);
      setPasswordInput("");
      Message.success(
        t("commandForm.target.sshPasswordSaved", {
          defaultValue: "SSH password saved",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("commandForm.target.sshPasswordSaveError", {
          defaultValue: "Failed to save SSH password",
        })}: ${msg}`,
      );
    } finally {
      setPasswordBusy(false);
    }
  }, [passwordHostAlias, passwordInput, t]);

  const handleClearPassword = useCallback(async (): Promise<void> => {
    if (passwordHostAlias === "") return;
    setPasswordBusy(true);
    try {
      await clearSshPassword(passwordHostAlias);
      setPasswordStored(false);
      Message.success(
        t("commandForm.target.sshPasswordCleared", {
          defaultValue: "SSH password cleared",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("commandForm.target.sshPasswordClearError", {
          defaultValue: "Failed to clear SSH password",
        })}: ${msg}`,
      );
    } finally {
      setPasswordBusy(false);
    }
  }, [passwordHostAlias, t]);

  const modeOptions: DropdownOption[] = [
    { value: MODE_LOCAL, label: t("commandForm.target.local", { defaultValue: "Local" }) },
    { value: MODE_REMOTE, label: t("commandForm.target.remote", { defaultValue: "Remote host" }) },
    {
      value: MODE_PROMPT,
      label: t("commandForm.target.prompt", { defaultValue: "Ask at run time" }),
    },
  ];

  // Host options come straight from the shared inventory. When the command's
  // stored alias is no longer in the inventory (host renamed/removed since the
  // command was saved), keep it visible as a disabled option so the user sees
  // what was configured rather than a silently-empty field.
  const hostOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = hosts.map((h) => ({
      value: h.name,
      label: h.name,
      description: h.hostName ?? undefined,
    }));
    if (
      selectedAlias !== "" &&
      !hosts.some((h) => h.name === selectedAlias)
    ) {
      opts.unshift({
        value: selectedAlias,
        label: `${selectedAlias} ${t("commandForm.target.hostUnavailableSuffix", {
          defaultValue: "(not in connections)",
        })}`,
        disabled: true,
      });
    }
    return opts;
  }, [hosts, selectedAlias, t]);

  // Reachability check state for the selected host (idle when none / unchecked).
  const selectedHost = hosts.find((h) => h.name === selectedAlias) ?? null;
  const checkState = useSshHostStore((s) =>
    selectedHost
      ? selectCheckState(s, selectedHost.id.source, selectedHost.id.name)
      : IDLE_CHECK_STATE,
  );

  const handleModeChange = (next: string): void => {
    if (next === MODE_LOCAL) {
      onChange({ kind: "local" });
    } else if (next === MODE_PROMPT) {
      onChange({ kind: "remotePrompt" });
    } else {
      // Switching to "Remote host": preserve any previously-selected alias,
      // else default to the first inventory host (empty string when none).
      const alias =
        selectedAlias !== ""
          ? selectedAlias
          : (hosts[0]?.name ?? "");
      onChange({ kind: "remote", alias });
    }
  };

  const handleHostChange = (next: string): void => {
    onChange({ kind: "remote", alias: next });
  };

  const isChecking = checkState.kind === "checking";
  const noHosts = !isLoading && hosts.length === 0;

  return (
    <div className="command-form__field">
      <span className="command-form__label">
        {t("commandForm.target.label", { defaultValue: "Where to run" })}
      </span>

      <Dropdown
        value={mode}
        options={modeOptions}
        onChange={handleModeChange}
        ariaLabel={t("commandForm.target.label", { defaultValue: "Where to run" })}
      />

      {mode === "remote" ? (
        <div className="command-form__target-host">
          <Dropdown
            value={selectedAlias}
            options={hostOptions}
            onChange={handleHostChange}
            ariaLabel={t("commandForm.target.host", { defaultValue: "SSH host" })}
            searchable={hostOptions.length > 8}
          />
          <button
            type="button"
            className="btn btn--ghost"
            disabled={isChecking || selectedHost === null}
            onClick={() => {
              if (selectedHost) void check(selectedHost);
            }}
          >
            {isChecking
              ? t("commandForm.target.checking", { defaultValue: "Checking…" })
              : t("commandForm.target.check", { defaultValue: "Check" })}
          </button>
        </div>
      ) : null}

      {/* Reachability result for the selected host. */}
      {mode === "remote" && checkState.kind === "done" ? (
        <span
          className="command-form__hint"
          role="note"
          data-reachable={checkState.result.reachable ? "true" : "false"}
        >
          {checkState.result.reachable
            ? t("commandForm.target.reachable", { defaultValue: "Host is reachable" })
            : t("commandForm.target.unreachable", {
                defaultValue: "Host is unreachable: {{message}}",
                message: checkState.result.message,
              })}
        </span>
      ) : null}

      {/* Empty-inventory guidance pointing at the Connections tab. */}
      {mode === "remote" && noHosts ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.target.noHosts", {
            defaultValue:
              "No SSH connections found. Add one in Environment → Connections.",
          })}
        </span>
      ) : null}

      {/* Limitations of remote runs in this version. Shown for any non-local
          mode so the user understands the contract before saving. */}
      {mode !== "local" ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.target.remoteLimitations", {
            defaultValue:
              "Remote runs ignore the working directory and environment variables, can't run as administrator, and use a POSIX shell (sh) on the host.",
          })}
        </span>
      ) : null}

      {/* Password-auth opt-in. Only shown for a remote target on Unix. When
          checked the runner prompts for a one-shot SSH password before each
          run; otherwise the run relies on keys / the SSH agent. The password is
          never saved. Hidden on Windows (the executor ignores it there). */}
      {mode !== "local" && !isWindows ? (
        <>
          <label className="command-form__field command-form__field--inline">
            <input
              type="checkbox"
              checked={promptSshPassword}
              onChange={(e) => onPromptSshPasswordChange(e.target.checked)}
            />
            <span>
              {t("commandForm.target.promptSshPassword", {
                defaultValue: "Ask for a password at run time",
              })}
            </span>
          </label>
          {promptSshPassword ? (
            <span className="command-form__hint" role="note">
              {t("commandForm.target.promptSshPasswordHint", {
                defaultValue:
                  "You'll be asked for the SSH password before each run. It is used once and never saved — prefer SSH keys for repeated runs. (Unix only.)",
              })}
            </span>
          ) : null}
        </>
      ) : null}

      {/* Persistent per-host SSH password (Phase 2). Only for a remote target
          with a chosen host, on Unix. Lets a password host run unattended (no
          run-time prompt). The value is stored in the OS keychain by the
          backend and never read back here — we only show whether one exists. */}
      {canManagePassword ? (
        <div className="command-form__field">
          <span className="command-form__label">
            {t("commandForm.target.sshPasswordLabel", {
              defaultValue: "Saved SSH password",
            })}
          </span>

          {editingPassword ? (
            <div className="command-form__target-host">
              <input
                className="input"
                type="password"
                autoComplete="off"
                aria-label={t("commandForm.target.sshPasswordInputLabel", {
                  defaultValue: "SSH password for {{alias}}",
                  alias: passwordHostAlias,
                })}
                value={passwordInput}
                disabled={passwordBusy}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSavePassword();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingPassword(false);
                    setPasswordInput("");
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={passwordBusy || passwordInput === ""}
                onClick={() => void handleSavePassword()}
              >
                {t("commandForm.target.sshPasswordSave", {
                  defaultValue: "Save",
                })}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={passwordBusy}
                onClick={() => {
                  setEditingPassword(false);
                  setPasswordInput("");
                }}
              >
                {t("commandForm.target.sshPasswordCancel", {
                  defaultValue: "Cancel",
                })}
              </button>
            </div>
          ) : (
            <div className="command-form__target-host">
              <span className="command-form__hint" role="note">
                {passwordStored
                  ? t("commandForm.target.sshPasswordStatusSaved", {
                      defaultValue: "Saved ✓",
                    })
                  : t("commandForm.target.sshPasswordStatusNone", {
                      defaultValue: "Not saved — keys/agent will be used.",
                    })}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={passwordBusy}
                onClick={() => {
                  setPasswordInput("");
                  setEditingPassword(true);
                }}
              >
                {passwordStored
                  ? t("commandForm.target.sshPasswordChange", {
                      defaultValue: "Change…",
                    })
                  : t("commandForm.target.sshPasswordSet", {
                      defaultValue: "Set password…",
                    })}
              </button>
              {passwordStored ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={passwordBusy}
                  onClick={() => void handleClearPassword()}
                >
                  {t("commandForm.target.sshPasswordClear", {
                    defaultValue: "Clear",
                  })}
                </button>
              ) : null}
            </div>
          )}

          <span className="command-form__hint" role="note">
            {t("commandForm.target.sshPasswordHint", {
              defaultValue:
                "Stored in your OS keychain for this host so it can run unattended. SSH keys are preferred; the password is a fallback. (Unix only.)",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
