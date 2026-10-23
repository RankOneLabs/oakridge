import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { useStore } from "../../state/store";
import type { SessionSnapshot } from "../../types";

interface SessionInventoryResponse { readonly sessions: readonly SessionSnapshot[] }

/** The live inbox snapshot and the session-list read together establish which
 * historical Oakridge attempt transcripts still exist after a page reload. */
async function readSessionInventory(): Promise<readonly SessionSnapshot[]> {
  const response = await fetch("/sessions");
  if (!response.ok) throw new Error(`Session inventory unavailable (${response.status})`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("sessions" in body) || !Array.isArray(body.sessions)
    || !body.sessions.every((session: unknown) => typeof session === "object" && session !== null
      && "sid" in session && typeof session.sid === "string" && "source" in session
      && (session.source === "acp" || session.source === "legacy_archive")))
    throw new Error("Invalid session inventory");
  return (body as SessionInventoryResponse).sessions;
}

export function useSessionInventorySeed(isEnabled: boolean): void {
  const hasInboxSnapshot = useStore((state) => state.hasInboxSnapshot);
  const hasSessionSeed = useStore((state) => state.hasSessionSeed);
  const seedSessions = useStore((state) => state.seedSessions);
  const inventory = useQuery({ queryKey: ["oakridge", "session-inventory-seed"], queryFn: readSessionInventory,
    enabled: isEnabled && hasInboxSnapshot && !hasSessionSeed, staleTime: Infinity });

  useEffect(() => {
    if (inventory.data) seedSessions([...inventory.data]);
  }, [inventory.data, seedSessions]);
}
