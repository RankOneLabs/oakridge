import type { OperatorUnitView } from "./operator-contracts/projections/unit-view";
import { oakridgeGet, runPath } from "./client-http";
import { parseUnitViews } from "./adapters/parse";
import { unwrap as unwrapAdapter } from "./adapters/core";

interface CachedUnits {
  readonly promise: Promise<readonly OperatorUnitView[]>;
  expiresAt: number;
  isLoading: boolean;
}
/** Run surfaces poll every ten seconds; a settled read must expire before their next poll. */
const UNIT_CACHE_FRESH_MS = 5_000;
const unitCache = new Map<string, CachedUnits>();
/** Every unit input field the adapters read; the rest repeats upstream artifacts in each unit. */
const UNIT_INPUT_FIELDS = ["assignment", "spec", "brief", "cohort", "repositories", "repository", "repository_key", "title", "workspace"];
export const readUnits = (runId: string): Promise<readonly OperatorUnitView[]> => {
  const cached = unitCache.get(runId);
  if (cached && (cached.isLoading || cached.expiresAt > Date.now())) return cached.promise;
  const path = `${runPath(runId)}/units?input_fields=${UNIT_INPUT_FIELDS.join(",")}`;
  const entry: CachedUnits = {
    expiresAt: 0,
    isLoading: true,
    promise: oakridgeGet<unknown>(path).then((value) => {
      const units = unwrapAdapter(path, parseUnitViews(value));
      entry.isLoading = false;
      entry.expiresAt = Date.now() + UNIT_CACHE_FRESH_MS;
      return units;
    }).catch((error) => {
      if (unitCache.get(runId) === entry) unitCache.delete(runId);
      throw error;
    }),
  };
  unitCache.set(runId, entry);
  return entry.promise;
};
export const invalidateCachedRunUnits = (runId: string | null): void => {
  if (runId) unitCache.delete(runId);
  else unitCache.clear();
};

