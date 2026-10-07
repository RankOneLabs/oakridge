import type { RunEvent } from "./run-event-types";

export interface OakridgeConfig {
  readonly available: boolean;
  readonly core_url?: string | null;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type RunEventFrame = RunEvent & { readonly replayed: boolean };
