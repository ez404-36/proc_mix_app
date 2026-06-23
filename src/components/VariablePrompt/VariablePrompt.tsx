import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { VariableSpec } from "../../types";
import { registerVariablePromptHandler } from "../../utils/variablePrompt";
import { CancelIcon, RunIcon } from "../icons";

interface ActivePrompt {
  specs: VariableSpec[];
  preset: Record<string, string>;
}

/**
 * Singleton modal that collects values for variables a command
 * references but for which the caller has not (yet) supplied a value.
 *
 * Lives at the App root so the runtime helper `promptForVariables()`
 * (called from non-React code paths like the executor wrapper in
 * `runCommand.ts`) can open it via a registered handler. The
 * component owns no trigger UI — it's purely reactive.
 *
 * Modeled on {@link AdminPasswordPrompt}: handler registration in a
 * synchronous useEffect, resolver kept in a ref, modal styling reuses
 * the `command-form__backdrop` / `command-form` classes for visual
 * consistency. The same StrictMode-safe pattern applies — see the
 * failures.md entry on Promise-wrapped unsubscribe.
 */
export function VariablePrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const [active, setActive] = useState<ActivePrompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const resolverRef = useRef<
    ((result: Record<string, string> | null) => void) | null
  >(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(
    (result: Record<string, string> | null): void => {
      const resolve = resolverRef.current;
      resolverRef.current = null;
      setValues({});
      setActive(null);
      // Resolve after local state is cleared so a re-entrant prompt in
      // the same tick (theoretical) sees a fresh empty modal.
      resolve?.(result);
    },
    [],
  );

  // Register the imperative handler exactly once. The pattern is the
  // same as AdminPasswordPrompt — synchronous useEffect, no Promise-
  // wrapped unsub. Re-mounting under StrictMode replaces the handler
  // with a fresh closure; any pending resolver from the prior mount is
  // cancelled to `null` so callers don't hang.
  useEffect(() => {
    registerVariablePromptHandler((specs, preset) => {
      return new Promise<Record<string, string> | null>((resolve) => {
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        // Seed the value map with the preset, plus an empty string
        // for every spec we're about to ask about (so controlled
        // inputs have a string to bind to from the first render).
        const seeded: Record<string, string> = { ...preset };
        for (const spec of specs) {
          if (!(spec.name in seeded)) {
            seeded[spec.name] = "";
          }
        }
        setValues(seeded);
        setActive({ specs, preset });
      });
    });
    return () => {
      registerVariablePromptHandler(null);
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
  }, []);

  // Focus the first input each time the modal becomes visible.
  useEffect(() => {
    if (active) {
      const id = window.requestAnimationFrame(() => {
        firstInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [active]);

  const handleCancel = useCallback((): void => {
    close(null);
  }, [close]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!active) return;
      // Build a result map containing only the variables this prompt
      // covered, in the spec order. Values left empty are passed
      // through verbatim — an empty string is a valid input here
      // (the parser will substitute "" into the template).
      const result: Record<string, string> = {};
      for (const spec of active.specs) {
        result[spec.name] = values[spec.name] ?? "";
      }
      close(result);
    },
    [active, close, values],
  );

  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  };

  if (!active) return null;

  const titleId = "variable-prompt-title";

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="command-form variable-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {t("variablePrompt.title", { defaultValue: "Provide variables" })}
          </h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="command-form__body">
            {active.specs.map((spec, index) => {
              const inputId = `variable-prompt-input-${spec.name}`;
              const isSensitive = spec.sensitive === true;
              return (
                <label
                  key={spec.name}
                  className="command-form__field"
                  htmlFor={inputId}
                >
                  <span className="command-form__label">{spec.name}</span>
                  {spec.description !== undefined &&
                  spec.description.trim() !== "" ? (
                    <span className="command-form__hint" role="note">
                      {spec.description}
                    </span>
                  ) : null}
                  <input
                    id={inputId}
                    ref={index === 0 ? firstInputRef : null}
                    className="input"
                    type={isSensitive ? "password" : "text"}
                    autoComplete={isSensitive ? "off" : undefined}
                    value={values[spec.name] ?? ""}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setValues((prev) => ({
                        ...prev,
                        [spec.name]: e.target.value,
                      }))
                    }
                  />
                </label>
              );
            })}
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
              {t("variablePrompt.cancel", { defaultValue: "Cancel" })}
            </button>
            <button type="submit" className="btn btn--run">
              <RunIcon />
              {t("variablePrompt.submit", { defaultValue: "Run" })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
