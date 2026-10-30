import { createHash, timingSafeEqual } from "node:crypto";
import type { TenantScope } from "../storage/database";

export interface Credential extends TenantScope { readonly token: string; readonly reviewer_id?: string }
export interface Credentials { readonly ingest: readonly Credential[]; readonly read: readonly Credential[];
  readonly grade?: readonly Credential[]; readonly export_raw?: readonly Credential[] }

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
/** A token has one immutable reviewer identity, including legacy in-process credentials. */
export function boundReviewer(credential: Credential): string {
  return credential.reviewer_id ?? `credential:${createHash("sha256").update(credential.token).digest("hex")}`;
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
  const grade = configuredCredentials(env.OBSERVATION_GRADE_CREDENTIALS);
  if (grade.some((credential) => !credential.reviewer_id?.trim()))
    throw new Error("grade credentials require a reviewer_id binding");
  const export_raw = configuredCredentials(env.OBSERVATION_EXPORT_RAW_CREDENTIALS);
  const all = [...ingest, ...read, ...grade, ...export_raw];
  if (all.some((item, index) => all.findIndex((candidate) => sameSecret(item.token, candidate.token)) !== index))
    throw new Error("observation credential tokens must be unique across capabilities");
  return { ingest, read, grade, export_raw };
}
