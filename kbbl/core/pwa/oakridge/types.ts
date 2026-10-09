export interface OakridgeConfig {
  readonly available: boolean;
  readonly core_url?: string | null;
  readonly fallback_refresh_ms?: number;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
