import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { registerWorkingDirPromptHandler } from '../../utils/workingDirPrompt';
import {
  usePromptAutoFocus,
  usePromptResolver,
} from '../../hooks/usePromptResolver';
import { PromptModal } from '../PromptModal/PromptModal';
import { CancelIcon, RunIcon } from '../icons';

/**
 * Singleton modal that asks the user for a working directory before a run
 * when the command has `promptWorkingDir: true`.
 *
 * Mounted once at the App root. Opened imperatively via
 * `promptForWorkingDir()` from `commandRunner.ts`, which lives outside the
 * React tree.
 *
 * Lifecycle (register/resolver/focus) is owned by `usePromptResolver`; the
 * portal/backdrop by `<PromptModal>`. Visibility is driven by `defaultValue`:
 * `null` means closed.
 */
export function WorkingDirPrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const [defaultValue, setDefaultValue] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { close } = usePromptResolver<[defaultValue: string], string>({
    register: registerWorkingDirPromptHandler,
    onOpen: (def) => {
      setValue(def);
      setDefaultValue(def);
    },
    onClose: () => {
      setValue('');
      setDefaultValue(null);
    },
  });

  usePromptAutoFocus(defaultValue !== null, inputRef, true);

  const handleCancel = useCallback((): void => {
    close(null);
  }, [close]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      close(value.trim());
    },
    [close, value],
  );

  if (defaultValue === null) return null;

  const titleId = 'working-dir-prompt-title';

  return (
    <PromptModal
      titleId={titleId}
      dialogClassName="variable-prompt working-dir-prompt"
      onBackdropCancel={handleCancel}
      title={t('workingDirPrompt.title')}
    >
      <form onSubmit={handleSubmit}>
        <div className="command-form__body">
          <label
            className="command-form__field"
            htmlFor="working-dir-prompt-input"
          >
            <span className="command-form__label">
              {t('workingDirPrompt.label')}
            </span>
            <span className="command-form__hint" role="note">
              {t('workingDirPrompt.hint')}
            </span>
            <input
              id="working-dir-prompt-input"
              ref={inputRef}
              className="input"
              type="text"
              value={value}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setValue(e.target.value)
              }
              placeholder={t('workingDirPrompt.placeholder')}
            />
          </label>
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
            {t('workingDirPrompt.cancel')}
          </button>
          <button type="submit" className="btn btn--run">
            <RunIcon />
            {t('workingDirPrompt.submit')}
          </button>
        </div>
      </form>
    </PromptModal>
  );
}
