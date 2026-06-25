// Generic factory for the imperative "open a singleton modal from outside the
// React tree" pattern.
//
// Several runtime flows (`triggerCommandRun`, the executor wrapper, …) need to
// pop a modal and await the user's answer, but they live OUTSIDE the React
// tree so they can't pull a modal into existence via state. The established
// solution is a module-level singleton: a `<…Prompt>` component registers an
// open-and-await handler at mount, and a runtime helper awaits it.
//
// Every such registry repeated the same shape — `let registeredHandler`, a
// `register…Handler`, a `promptFor…` that returns `null` when no handler is
// mounted, and a `_reset…Handler` test hook. This factory captures that shape
// once; the per-domain modules become thin, fully-typed specializations.
//
// Only one prompt of a given kind can be active at a time. If `prompt` is
// called while a handler is mounted, it delegates to that handler; when no
// handler is mounted (tests / SSR / early boot) it resolves to `null`, which
// every caller treats as "user cancelled".

/**
 * The function shape a modal component registers: it shows its UI, waits for
 * the user to submit or cancel, and resolves with a `Result` or `null` on
 * cancel. `Args` are the values the caller passes through to the modal (e.g.
 * the SSH alias, the default working directory, the variable specs).
 */
export type PromptHandler<Args extends readonly unknown[], Result> = (
  ...args: Args
) => Promise<Result | null>;

/**
 * The public surface of a prompt registry. Each specialization re-exports
 * these three members under domain-specific names so existing callers and
 * tests keep working unchanged.
 */
export interface PromptRegistry<Args extends readonly unknown[], Result> {
  /**
   * Register the modal's open-and-await function. Called once by the modal
   * component on mount, and again with `null` on unmount. Last-write-wins:
   * re-registering replaces the previous handler.
   */
  register: (handler: PromptHandler<Args, Result> | null) => void;
  /**
   * Request the modal to open. Resolves with the handler's `Result`/`null`,
   * or `null` when no handler is registered (treated as "cancelled").
   */
  prompt: (...args: Args) => Promise<Result | null>;
  /**
   * Test-only: clear the registered handler between cases (the module is
   * loaded once per worker). Marked with a leading underscore to discourage
   * production callers.
   *
   * @internal
   */
  _reset: () => void;
}

/**
 * Build a fresh, independent prompt registry. The returned object's members
 * close over a private `registeredHandler` slot — separate calls never share
 * state.
 */
export function createPromptRegistry<
  Args extends readonly unknown[],
  Result,
>(): PromptRegistry<Args, Result> {
  let registeredHandler: PromptHandler<Args, Result> | null = null;

  return {
    register(handler: PromptHandler<Args, Result> | null): void {
      registeredHandler = handler;
    },
    async prompt(...args: Args): Promise<Result | null> {
      if (!registeredHandler) {
        return null;
      }
      return registeredHandler(...args);
    },
    _reset(): void {
      registeredHandler = null;
    },
  };
}
