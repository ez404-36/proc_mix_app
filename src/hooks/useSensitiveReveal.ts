import { useCallback, useState } from 'react';

export interface SensitiveReveal {
  /** True when the value for `key` is currently revealed. */
  isRevealed: (key: string) => boolean;
  /** Toggle the revealed state for `key`. */
  toggle: (key: string) => void;
}

/**
 * Track which masked (sensitive) values the user has chosen to reveal.
 *
 * Returns an object (never a positional tuple — project convention) with a
 * stable `toggle` callback and a stable `isRevealed` predicate. State is a
 * `Set<string>` of revealed keys; everything not in the set is masked.
 */
export function useSensitiveReveal(): SensitiveReveal {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const isRevealed = useCallback(
    (key: string) => revealed.has(key),
    [revealed],
  );

  return { isRevealed, toggle };
}
