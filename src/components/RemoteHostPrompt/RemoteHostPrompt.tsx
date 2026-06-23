import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { registerRemoteHostPromptHandler } from "../../utils/remoteHostPrompt";
import { useSshHostStore } from "../../stores/sshHostStore";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { CancelIcon, RunIcon } from "../icons";

/**
 * Singleton modal that asks the user which SSH host to run on before a run
 * whose target is `{ kind: 'remotePrompt' }` ("ask at run time").
 *
 * Mounted once at the App root. Opened imperatively via `promptForRemoteHost()`
 * from `commandRunner.ts`, which lives outside the React tree. Follows the same
 * StrictMode-safe handler-registration pattern as `WorkingDirPrompt`.
 *
 * The host list is read from the SAME `useSshHostStore` the Environment →
 * Connections tab uses, so the offered hosts always match that inventory.
 */
export function RemoteHostPrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const hosts = useSshHostStore((s) => s.hosts);
  const load = useSshHostStore((s) => s.load);

  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const resolverRef = useRef<((result: string | null) => void) | null>(null);

  const close = useCallback((result: string | null): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    setAlias("");
    resolve?.(result);
  }, []);

  useEffect(() => {
    registerRemoteHostPromptHandler(() => {
      return new Promise<string | null>((resolve) => {
        // If a previous prompt is somehow still open, cancel it first so the
        // new request owns the single resolver.
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        // Refresh the inventory when empty so the picker isn't blank on first
        // use (e.g. the Connections tab was never visited this session).
        if (hosts.length === 0) {
          void load();
        }
        setAlias((prev) => (prev !== "" ? prev : (hosts[0]?.name ?? "")));
        setOpen(true);
      });
    });
    return () => {
      registerRemoteHostPromptHandler(null);
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
    // `hosts`/`load` are read at call time inside the handler closure; we only
    // need to register once. The handler reads the latest store via the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the default selection valid as the inventory arrives.
  useEffect(() => {
    if (open && alias === "" && hosts.length > 0) {
      setAlias(hosts[0]?.name ?? "");
    }
  }, [open, alias, hosts]);

  const handleCancel = useCallback((): void => {
    close(null);
  }, [close]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (alias === "") return;
      close(alias);
    },
    [close, alias],
  );

  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  };

  if (!open) return null;

  const titleId = "remote-host-prompt-title";
  const hostOptions: DropdownOption[] = hosts.map((h) => ({
    value: h.name,
    label: h.name,
    description: h.hostName ?? undefined,
  }));
  const noHosts = hosts.length === 0;

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="command-form variable-prompt remote-host-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {t("remoteHostPrompt.title", { defaultValue: "Choose a remote host" })}
          </h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="command-form__body">
            <div className="command-form__field">
              <span className="command-form__label">
                {t("remoteHostPrompt.label", { defaultValue: "SSH host" })}
              </span>
              {noHosts ? (
                <span className="command-form__hint" role="note">
                  {t("remoteHostPrompt.noHosts", {
                    defaultValue:
                      "No SSH connections found. Add one in Environment → Connections.",
                  })}
                </span>
              ) : (
                <Dropdown
                  value={alias}
                  options={hostOptions}
                  onChange={setAlias}
                  ariaLabel={t("remoteHostPrompt.label", { defaultValue: "SSH host" })}
                  searchable={hostOptions.length > 8}
                />
              )}
            </div>
          </div>
          <div className="command-form__footer">
            <button
              type="button"
              className="btn btn--cancel"
              onClick={handleCancel}
            >
              <span className="btn--cancel-icon">
                <CancelIcon />
              </span>
              {t("remoteHostPrompt.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              type="submit"
              className="btn btn--run"
              disabled={alias === ""}
            >
              <RunIcon />
              {t("remoteHostPrompt.submit", { defaultValue: "Run" })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
