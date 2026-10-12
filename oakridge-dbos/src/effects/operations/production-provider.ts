import { PROVIDER_ERROR_CODES } from "../provider-catalog";
import type { EffectProvider } from "../provider";

/**
 * The production provider until the executor's agent and code paths land
 * (rescue spec R3). It starts nothing: every start is refused with a typed
 * code, so its attempt fails visibly instead of hanging, and a stop is
 * acknowledged because no execution exists.
 */
export function createEffectProvider(): EffectProvider {
  const refusal = { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.provider_not_ported,
    detail: "the executor's agent and code worker paths are not ported to effect instructions yet" } as const;
  return {
    start: async () => refusal,
    observe: async () => refusal,
    stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
  };
}
