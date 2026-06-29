// Run prompt (run setup) — collects variable values before firing a run.
//
// When a command declares variables that need a value at runtime (no default),
// the headless run endpoint would reject with `missingVariable`. This modal
// asks for those values up front, then fires the run with them. Commands with
// no variables (and all workflows) skip the prompt and run directly — the
// caller decides whether to mount this modal.
//
// Sensitive variables are entered with a password field; their values are sent
// once over the (token-authenticated) API and never persisted in the browser.

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { ApiEntitySummary, VariableSpec } from "../api/types";
import { ApiError } from "../api/client";
import { useRunActions } from "../hooks/useRunActions";

interface RunPromptProps {
  entity: ApiEntitySummary;
  variables: VariableSpec[];
  onClose: () => void;
  /** Called after the run is successfully fired. */
  onFired: () => void;
}

/**
 * Whether a variable must be asked for: it has no default value. (Sensitive
 * variables never expose a default to the client, so they are always asked.)
 */
function needsInput(spec: VariableSpec): boolean {
  return spec.defaultValue === undefined;
}

export function RunPrompt({
  entity,
  variables,
  onClose,
  onFired,
}: RunPromptProps): React.JSX.Element {
  const { t } = useTranslation();
  const { run } = useRunActions();
  const prompted = useMemo(() => variables.filter(needsInput), [variables]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await run(entity, values);
      onFired();
    } catch (err) {
      if (err instanceof ApiError && err.code === "missingVariable") {
        setError(
          t("web.run.missingVariable", "A required value is missing: {{name}}", {
            name: err.variable ?? "",
          }),
        );
      } else {
        setError(t("web.run.failed", "Could not start the run."));
      }
    } finally {
      setBusy(false);
    }
  }

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="command-form command-form--meta"
        role="dialog"
        aria-modal="true"
        aria-label={t("web.run.title", "Run {{name}}", { name: entity.name })}
        onSubmit={onSubmit}
      >
        <h2 className="command-form__title">
          {t("web.run.title", "Run {{name}}", { name: entity.name })}
        </h2>
        <p className="view-subtitle">
          {t("web.run.subtitle", "Provide values for this run.")}
        </p>

        {prompted.map((spec) => (
          <div className="form-field" key={spec.name}>
            <label htmlFor={`var-${spec.name}`}>
              {spec.name}
              {spec.sensitive ? (
                <span className="shell-badge command-view__var-sensitive">
                  {t("commandForm.variables.sensitive")}
                </span>
              ) : null}
            </label>
            <input
              id={`var-${spec.name}`}
              type={spec.sensitive ? "password" : "text"}
              autoComplete="off"
              value={values[spec.name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [spec.name]: e.target.value }))
              }
            />
            {spec.description ? (
              <p className="form-hint">{spec.description}</p>
            ) : null}
          </div>
        ))}

        {error ? <p className="form-hint form-hint--error">{error}</p> : null}

        <div className="command-form__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            type="submit"
            className="btn command-form__action command-form__action--run"
            disabled={busy}
          >
            {busy ? t("web.run.starting", "Starting…") : t("common.run")}
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(modal, document.body);
}
