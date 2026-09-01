import { useQuery, useMutation } from "@tanstack/react-query";
import type { Skill } from "../../runtime-interface";
import { randomUuid } from "../lib/random-uuid";

export function useSkills(sid: string): Skill[] {
  const query = useQuery({
    queryKey: ["skills", sid],
    queryFn: async (): Promise<Skill[]> => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sid)}/skills`);
        if (!res.ok) return [];
        return (await res.json()) as Skill[];
      } catch {
        return [];
      }
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return query.data ?? [];
}

export function useInvokeSkill(sid: string) {
  return useMutation({
    mutationFn: async (payload: {
      skill_id: string;
      args: Record<string, string>;
    }) => {
      const res = await fetch(
        `/sessions/${encodeURIComponent(sid)}/skills/invoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });
}

/**
 * Dispatches one agent-provided slash command (§16.1) as a normal
 * operator turn: ACP has no run-command RPC — the convention is the
 * command name as prompt text.
 */
export function useInvokeAgentCommand(sid: string) {
  return useMutation({
    mutationFn: async (commandName: string) => {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `/${commandName}`,
          client_message_id: randomUuid(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });
}
