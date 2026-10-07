import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SqlExecutor } from "./sql-executor";
import type { EffectPayload } from "../effects/intents";

const PREFIX = "enc:v1:";
const KEY_NAME = "OAKRIDGE_EFFECT_ENCRYPTION_KEY";

function configuredKey(): Buffer {
  const raw = process.env[KEY_NAME];
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error(`${KEY_NAME} must be a configured 32-byte base64url key`);
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error(`${KEY_NAME} must be a configured 32-byte base64url key`);
  return key;
}

export function sealEffectPayload(payload: EffectPayload): EffectPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", configuredKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(payload.invocation.bytes, "utf8"), cipher.final()]);
  const bytes = `${PREFIX}${nonce.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
  return { ...payload, invocation: { ...payload.invocation, bytes } };
}

export function unsealEffectPayload(payload: EffectPayload): EffectPayload {
  const bytes = payload.invocation.bytes;
  if (!bytes.startsWith(PREFIX)) throw new Error("effect intent contains unencrypted invocation bytes");
  const [nonce_raw, tag_raw, ciphertext_raw] = bytes.slice(PREFIX.length).split(":");
  if (!nonce_raw || !tag_raw || !ciphertext_raw) throw new Error("effect intent ciphertext is malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", configuredKey(), Buffer.from(nonce_raw, "base64url"));
    decipher.setAuthTag(Buffer.from(tag_raw, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext_raw, "base64url")), decipher.final()]).toString("utf8");
    return { ...payload, invocation: { ...payload.invocation, bytes: plaintext } };
  } catch { throw new Error("effect intent encryption key is wrong or ciphertext is damaged"); }
}

/** Startup verifies the configured key against persisted encrypted bytes before DBOS resumes work. */
export async function verifyEffectEncryption(db: SqlExecutor): Promise<void> {
  configuredKey();
  const rows = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent LIMIT 1", []);
  if (rows[0]) unsealEffectPayload(rows[0].payload);
}
