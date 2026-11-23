import { buildAgentEnv, type AgentProfile } from "./agent-profile";

/** Readiness is an observation, not a session launch or authentication attempt. */
export type ProfileReadiness =
  | { readonly kind: "ok"; readonly detail: string }
  | { readonly kind: "unavailable_optional" | "failed"; readonly detail: string; readonly fix: string };
export interface AgentProfileReadiness {
  readonly profile_id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly readiness: ProfileReadiness;
}
export type AuthProbe = (command: readonly string[], env: Record<string, string>) => Promise<boolean>;
async function probeAuth(command: readonly string[], env: Record<string, string>): Promise<boolean> {
  try {
    const child = Bun.spawn([...command], { env, stdout: "ignore", stderr: "ignore" });
    const timeout = setTimeout(() => child.kill(), 3000);
    try { return await child.exited === 0; } finally { clearTimeout(timeout); }
  } catch { return false; }
}
export async function readProfileReadiness(profile: AgentProfile, probe: AuthProbe = probeAuth): Promise<AgentProfileReadiness> {
  const result = (readiness: ProfileReadiness): AgentProfileReadiness => ({ profile_id: profile.id, label: profile.label, enabled: profile.enabled, readiness });
  if (!profile.enabled) return result({ kind: "unavailable_optional", detail: "Profile is disabled", fix: "Enable this ACP profile in kbbl configuration" });
  const env = buildAgentEnv(profile.env_policy, process.env);
  if (!Bun.which(profile.command, { PATH: env.PATH })) return result({ kind: "failed", detail: "ACP adapter executable is missing", fix: "Run bun install --frozen-lockfile or correct the profile command" });
  if (!profile.requireLoadSession) return result({ kind: "failed", detail: "Profile does not support resumable delegated sessions", fix: "Enable requireLoadSession for this ACP profile" });
  if (!profile.skillDiscovery) return result({ kind: "failed", detail: "Profile has no session skill discovery support", fix: "Configure skillDiscovery for this ACP profile" });
  const auth = profile.auth_probe;
  if (!auth) return result({ kind: "unavailable_optional", detail: "Authentication introspection is unavailable for this profile", fix: "Verify authentication with this profile's CLI before launching" });
  if (!await probe(auth.command, env)) return result({ kind: "failed", detail: "Agent CLI authentication is unavailable or expired", fix: auth.fix });
  return result({ kind: "ok", detail: "ACP adapter and skill discovery configured; CLI authentication is ready" });
}

export type ProfileReadinessReader = () => Promise<readonly AgentProfileReadiness[]>;
interface ReadinessSnapshot { readonly profiles: readonly AgentProfileReadiness[]; readonly expires_at: number }
export interface SharedReadinessOptions {
  readonly read: ProfileReadinessReader;
  readonly now?: () => number;
  readonly cache_ms?: number;
}
/** Share work across concurrent polls and retain results briefly to bound process creation. */
export function sharedProfileReadiness({ read, now = Date.now, cache_ms = 10_000 }: SharedReadinessOptions): ProfileReadinessReader {
  let snapshot: ReadinessSnapshot | null = null;
  let in_flight: Promise<readonly AgentProfileReadiness[]> | null = null;
  return () => {
    if (snapshot && now() < snapshot.expires_at) return Promise.resolve(snapshot.profiles);
    if (in_flight) return in_flight;
    in_flight = Promise.resolve().then(read).then((profiles) => {
      snapshot = { profiles, expires_at: now() + cache_ms };
      return profiles;
    }).finally(() => { in_flight = null; });
    return in_flight;
  };
}
