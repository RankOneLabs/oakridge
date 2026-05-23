import { useQuery } from "@tanstack/react-query";

import type { Result } from "../lib/result";
import { responseError } from "../lib/http";
import type { PendingPlanCard, PendingBriefCard } from "../types";

type PendingPlansResult = Result<PendingPlanCard[], Error>;
type PendingBriefsResult = Result<PendingBriefCard[], Error>;

export function usePendingReviews(): {
  pendingPlans: PendingPlansResult | null;
  pendingBriefs: PendingBriefsResult | null;
} {
  const plansQuery = useQuery({
    queryKey: ["plans", "pending_approval"],
    queryFn: async (): Promise<PendingPlansResult> => {
      const res = await fetch("/plans?status=pending_approval");
      if (!res.ok) return { ok: false, error: await responseError(res, "pending plans") };
      return { ok: true, value: (await res.json()) as PendingPlanCard[] };
    },
  });
  const briefsQuery = useQuery({
    queryKey: ["briefs", "pending_approval"],
    queryFn: async (): Promise<PendingBriefsResult> => {
      const res = await fetch("/briefs?status=pending_approval");
      if (!res.ok) return { ok: false, error: await responseError(res, "pending briefs") };
      return { ok: true, value: (await res.json()) as PendingBriefCard[] };
    },
  });
  return {
    pendingPlans: plansQuery.data ?? null,
    pendingBriefs: briefsQuery.data ?? null,
  };
}
