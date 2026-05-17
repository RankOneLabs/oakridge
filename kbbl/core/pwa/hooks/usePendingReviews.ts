import { useEffect, useState } from "react";

import type { PendingPlanCard, PendingBriefCard } from "../types";

export function usePendingReviews(): {
  pendingPlans: PendingPlanCard[];
  pendingBriefs: PendingBriefCard[];
} {
  const [pendingPlans, setPendingPlans] = useState<PendingPlanCard[]>([]);
  const [pendingBriefs, setPendingBriefs] = useState<PendingBriefCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchPending = async () => {
      try {
        const [plansRes, briefsRes] = await Promise.all([
          fetch("/plans?status=pending_approval"),
          fetch("/briefs?status=pending_approval"),
        ]);
        if (cancelled) return;
        if (plansRes.ok) {
          const plans = (await plansRes.json()) as PendingPlanCard[];
          if (!cancelled) setPendingPlans(plans);
        }
        if (briefsRes.ok) {
          const briefs = (await briefsRes.json()) as PendingBriefCard[];
          if (!cancelled) setPendingBriefs(briefs);
        }
      } catch {
        // network error; sections stay hidden
      }
    };
    void fetchPending();
    return () => { cancelled = true; };
  }, []);

  return { pendingPlans, pendingBriefs };
}
