import { useQuery } from "@tanstack/react-query";

import type { PendingPlanCard, PendingBriefCard } from "../types";

export function usePendingReviews(): {
  pendingPlans: PendingPlanCard[];
  pendingBriefs: PendingBriefCard[];
} {
  const plansQuery = useQuery({
    queryKey: ["plans", "pending_approval"],
    queryFn: async (): Promise<PendingPlanCard[]> => {
      const res = await fetch("/plans?status=pending_approval");
      if (!res.ok) return [];
      return (await res.json()) as PendingPlanCard[];
    },
  });
  const briefsQuery = useQuery({
    queryKey: ["briefs", "pending_approval"],
    queryFn: async (): Promise<PendingBriefCard[]> => {
      const res = await fetch("/briefs?status=pending_approval");
      if (!res.ok) return [];
      return (await res.json()) as PendingBriefCard[];
    },
  });
  return {
    pendingPlans: plansQuery.data ?? [],
    pendingBriefs: briefsQuery.data ?? [],
  };
}
