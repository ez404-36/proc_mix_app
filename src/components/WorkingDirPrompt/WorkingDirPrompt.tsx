import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  registerWorkingDirPromptHandler,
} from '../../utils/workingDirPrompt';
import { CancelIcon, RunIcon } from '../icons';

/**
 * Singleton modal that asks the user for a working directory before a run
 * when the command has `promptWorkingDir: true`.
 *
 * Mounted once at the App root. Opened imperatively via
 * `promptForWorkingDir()` from `commandRunner.ts`, which lives outside the
 * React tree. Follows the same StrictMode-safe handler-registration pattern
 * as `VariablePrompt`.
 */
export function WorkingDirPrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const [defaultValue, setDefaultValue] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const resolverRef = useRef<((result: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback((result: string | null): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setValue('');
    setDefaultValue(null);
    resolve?.(result);
  }, []);

  useEffect(() => {
    registerWorkingDirPromptHandler((def) => {
      return new Promise<string | null>((resolve) => {
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        setValue(def);
        setDefaultValue(def);
      });
    });
    return () => {
      registerWorkingDirPromptHandler(null);
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (defaultValue !== null) {
      const id = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [defaultValue]);

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

  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  };

  if (defaultValue === null) return null;

  const titleId = 'working-dir-prompt-title';

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="command-form variable-prompt working-dir-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {t('workingDirPrompt.title')}
          </h2>
        </div>
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
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
