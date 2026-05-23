import { useQuery } from "@tanstack/react-query";

export type HandoffStatus = "idle" | "loading" | "ok" | "missing" | "error";

interface HandoffResult {
  status: "missing" | "ok";
  body: string | null;
}

export function useSessionHandoff(
  sid: string,
  enabled: boolean,
): { handoff: string | null; status: HandoffStatus } {
  const query = useQuery({
    queryKey: ["session", sid, "handoff"],
    enabled,
    queryFn: async (): Promise<HandoffResult> => {
      const res = await fetch(`/${encodeURIComponent(sid)}/handoff`);
      if (res.status === 404) return { status: "missing", body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { status: "ok", body: text };
    },
    // 404 is a real "no handoff on disk" answer, not a transient failure to
    // retry. We map it onto status="missing" in the queryFn instead.
    retry: false,
  });

  if (!enabled) return { handoff: null, status: "idle" };
  if (query.isPending) return { handoff: null, status: "loading" };
  if (query.isError) return { handoff: null, status: "error" };
  if (query.data?.status === "missing") return { handoff: null, status: "missing" };
  if (query.data?.status === "ok") return { handoff: query.data.body, status: "ok" };
  return { handoff: null, status: "idle" };
}
