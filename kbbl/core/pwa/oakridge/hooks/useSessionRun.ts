import { useQuery } from "@tanstack/react-query";
import { fetchSessionRun } from "../client";

/**
 * The run a session belongs to, or null when it belongs to none. Resolves a
 * session whose work finished and whose cleanup completed — this is navigation,
 * not a close-safety hold.
 */
export function useSessionRun(sessionId: string, enabled = true) { return useQuery({ queryKey: ["oakridge", "session", sessionId, "run"], queryFn: () => fetchSessionRun(sessionId), refetchInterval: 10_000, enabled }); }
