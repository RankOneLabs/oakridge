import { useQuery } from "@tanstack/react-query";

interface ServerConfigResponse {
  defaultWorkdir: string;
  softThresholdTokens?: number;
}

export interface ServerConfig {
  defaultWorkdir: string;
  softThresholdTokens?: number;
}

/**
 * Fetches the server's /config once. Returns null until the fetch resolves
 * so callers can render a "loading" placeholder rather than racing forms
 * with empty defaults. Cached indefinitely — the server's config doesn't
 * change mid-session, and SessionTopBar's PATCH /config invalidates this
 * query so the next read reflects the server response.
 */
export function useServerConfig(): ServerConfig | null {
  const query = useQuery({
    queryKey: ["config"],
    queryFn: async (): Promise<ServerConfigResponse> => {
      const res = await fetch("/config");
      if (!res.ok) throw new Error(`config: ${res.status}`);
      return (await res.json()) as ServerConfigResponse;
    },
    staleTime: Infinity,
  });
  if (!query.data) return null;
  return {
    defaultWorkdir: query.data.defaultWorkdir,
    softThresholdTokens:
      typeof query.data.softThresholdTokens === "number"
        ? query.data.softThresholdTokens
        : undefined,
  };
}
