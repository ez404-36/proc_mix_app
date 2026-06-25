import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { VariableSpec } from "../../types";
import { registerVariablePromptHandler } from "../../utils/variablePrompt";
import {
  usePromptAutoFocus,
  usePromptResolver,
} from "../../hooks/usePromptResolver";
import { PromptModal } from "../PromptModal/PromptModal";
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
 * Lifecycle (register/resolver/focus) is owned by `usePromptResolver`; the
 * portal/backdrop by `<PromptModal>`. Visibility is driven by `active`:
 * `null` means closed.
 */
export function VariablePrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const [active, setActive] = useState<ActivePrompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  const { close } = usePromptResolver<
    [specs: VariableSpec[], preset: Record<string, string>],
    Record<string, string>
  >({
    register: registerVariablePromptHandler,
    onOpen: (specs, preset) => {
      // Seed the value map with the preset, plus an empty string for every
      // spec we're about to ask about (so controlled inputs have a string to
      // bind to from the first render).
      const seeded: Record<string, string> = { ...preset };
      for (const spec of specs) {
        if (!(spec.name in seeded)) {
          seeded[spec.name] = "";
        }
      }
      setValues(seeded);
      setActive({ specs, preset });
    },
    onClose: () => {
      setValues({});
      setActive(null);
    },
  });

  usePromptAutoFocus(active !== null, firstInputRef);

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

  if (!active) return null;

  const titleId = "variable-prompt-title";

  return (
    <PromptModal
      titleId={titleId}
      dialogClassName="variable-prompt"
      onBackdropCancel={handleCancel}
      title={t("variablePrompt.title", { defaultValue: "Provide variables" })}
    >
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
    </PromptModal>
  );
}
