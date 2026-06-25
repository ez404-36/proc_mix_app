import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { PromptHandler } from "../utils/createPromptRegistry";

/**
 * Shared lifecycle for the singleton "open a modal from outside the React
 * tree and await the user's answer" prompts (admin password, SSH password,
 * working dir, variables, remote host).
 *
 * Every prompt component repeated the same imperative scaffolding:
 *   - a `resolverRef` holding the in-flight Promise's `resolve`,
 *   - a mount-only `useEffect` that registers an open-and-await handler
 *     (cancelling any stranded prior resolver first) and unregisters +
 *     cancels on unmount,
 *   - a `close(result)` that nulls the resolver, clears local UI state, then
 *     resolves,
 *   - an auto-focus effect that focuses an input on the next frame each time
 *     the modal becomes visible.
 *
 * This hook owns all of that. The component supplies only:
 *   - `register`: the registry's `register` fn (the IPC-free singleton slot),
 *   - `onOpen(...args)`: set the component's "visible" state from the args,
 *   - `onClose()`: clear the component's local state.
 *
 * It does NOT import any modal component, so it stays inside the hooks layer
 * (dependency-cruiser forbids `hooks → components`). The portal/backdrop
 * markup lives in `<PromptModal>`.
 */
export interface UsePromptResolverOptions<
  Args extends readonly unknown[],
  Result,
> {
  /** The registry's `register` function (stable module-level reference). */
  register: (handler: PromptHandler<Args, Result> | null) => void;
  /**
   * Called (synchronously, inside the registered handler) when a prompt is
   * requested. Use it to set the component's visibility/seed state from
   * `args`. Must not throw.
   */
  onOpen: (...args: Args) => void;
  /**
   * Called by `close()` BEFORE the awaiting Promise resolves, to clear local
   * UI state (inputs, visibility). Keeps the "resolve after state cleared"
   * ordering every prompt relied on so a re-entrant prompt sees a fresh modal.
   */
  onClose: () => void;
}

export interface UsePromptResolver<Result> {
  /**
   * Resolve the in-flight prompt with `result` (or `null` to cancel),
   * clearing local state first. No-op when nothing is open.
   */
  close: (result: Result | null) => void;
}

export function usePromptResolver<Args extends readonly unknown[], Result>(
  options: UsePromptResolverOptions<Args, Result>,
): UsePromptResolver<Result> {
  const { register, onOpen, onClose } = options;

  // Resolver kept in a ref so the handler registered at mount reads a stable
  // reference across re-renders. `null` between prompts; non-null only while a
  // prompt is open.
  const resolverRef = useRef<((value: Result | null) => void) | null>(null);

  // Keep the latest callbacks in refs so the mount-only effect's handler
  // closure always calls the current versions without re-registering (which
  // would clobber an in-flight prompt).
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const close = useCallback((result: Result | null): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    onCloseRef.current();
    // Resolve AFTER local state is cleared so a re-entrant prompt that fires
    // in the same tick (theoretical) sees a fresh empty modal, not a stale one.
    resolve?.(result);
  }, []);

  // Register the imperative handler exactly once. Re-registering on every
  // render would clobber an in-flight prompt; the empty dep array pins us to
  // mount/unmount.
  useEffect(() => {
    register((...args: Args) => {
      return new Promise<Result | null>((resolve) => {
        // If a previous resolver is somehow still around (the modal didn't get
        // to close), force-cancel it first so we never strand a Promise.
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        onOpenRef.current(...args);
      });
    });
    return () => {
      register(null);
      // If we're unmounted while a prompt is open (e.g. hot reload), resolve
      // the outstanding Promise to null so callers don't hang forever.
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
    // `register` is a stable module-level fn; the open/close callbacks are read
    // from refs. We intentionally register only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { close };
}

/**
 * Auto-focus (and optionally select) an input on the next animation frame each
 * time the modal becomes visible. The input only exists in the DOM while the
 * modal is open, so the effect reruns on every `isOpen` transition.
 */
export function usePromptAutoFocus(
  isOpen: boolean,
  ref: RefObject<HTMLInputElement | null>,
  select = false,
): void {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const id = window.requestAnimationFrame(() => {
      ref.current?.focus();
      if (select) {
        ref.current?.select();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen, ref, select]);
}
