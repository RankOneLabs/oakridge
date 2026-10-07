/** Shortest interval worth scheduling; below it the fallback refresh becomes a poll storm. */
export const MIN_FALLBACK_REFRESH_MS = 1_000;
export const DEFAULT_FALLBACK_REFRESH_MS = 30_000;

export interface FallbackRefreshSources {
  /** What the authority stated in its config response, when it stated one. */
  readonly served: unknown;
  /** The build-time default baked into the bundle. */
  readonly configured: unknown;
}

const selectInterval = (candidate: unknown): number | null => {
  if (candidate === null || candidate === undefined || candidate === "") return null;
  const value = Number(candidate);
  return Number.isFinite(value) && value >= MIN_FALLBACK_REFRESH_MS ? value : null;
};

/**
 * The authority's own interval wins, so an operator can retune the fallback
 * refresh without rebuilding the bundle. The build-time value is a default for
 * an authority that does not state one, not an override of one that does.
 */
export const selectFallbackRefreshMs = ({ served, configured }: FallbackRefreshSources): number =>
  selectInterval(served) ?? selectInterval(configured) ?? DEFAULT_FALLBACK_REFRESH_MS;
