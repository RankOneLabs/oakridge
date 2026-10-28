import { timingSafeEqual } from "node:crypto";
import type { TenantScope } from "../storage/database";

export interface Credential extends TenantScope { readonly token: string }
export interface Credentials { readonly ingest: readonly Credential[]; readonly read: readonly Credential[] }

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}
export function credentialFor(header: string | undefined, credentials: readonly Credential[]): Credential | null {
  const token = bearerToken(header);
  if (!token) return null;
  return credentials.find((credential) => sameSecret(token, credential.token)) ?? null;
}

function configuredCredentials(raw: string | undefined): readonly Credential[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => item && typeof item === "object"
    && typeof item.token === "string" && item.token.length > 0 && typeof item.producer === "string" && item.producer.length > 0
    && typeof item.namespace === "string" && item.namespace.length > 0)) throw new Error("invalid observation credential configuration");
  return parsed as Credential[];
}
/** Each configured token maps to one pair and one capability. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials {
  const ingest = configuredCredentials(env.OBSERVATION_INGEST_CREDENTIALS);
  const read = configuredCredentials(env.OBSERVATION_READ_CREDENTIALS);
  const all = [...ingest, ...read];
  if (all.some((item, index) => all.findIndex((candidate) => sameSecret(item.token, candidate.token)) !== index))
    throw new Error("observation credential tokens must be unique across capabilities");
  return { ingest, read };
}
