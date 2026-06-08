/**
 * Format a millisecond duration as a short human string (e.g. "1.2 s",
 * "350 ms"). Sub-second values render in milliseconds; one decimal of seconds
 * otherwise. Shared by the scheduled-run history surfaces (the schedule view's
 * История tab and the global History list) so they format durations
 * identically.
 *
 * NOTE: `OutputPanel` keeps its own variant (two decimals + `undefined`
 * handling); consolidating that is a separate refactor and intentionally left
 * out of scope here.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
