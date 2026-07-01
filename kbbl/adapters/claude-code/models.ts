/**
 * CC-specific model allowlist. Imported by the POST /sessions handler to
 * validate the body's `model` field before it reaches `--model` argv. Lives
 * under adapters/claude-code/ because the namespace is CC-specific; codex
 * (planned second adapter) will have its own list.
 *
 * Aliases (`opus`/`sonnet`/`haiku`) are accepted by CC but resolve to
 * "latest of family" at spawn time, which is fragile across CC upgrades.
 * They're allowed here so power-user API callers aren't blocked, but the
 * PWA dropdown only surfaces pinned ids.
 */
export const ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "opus",
  "sonnet",
  "haiku",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export function isAllowedModel(value: string): value is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(value);
}
