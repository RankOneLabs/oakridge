import { createHash } from "node:crypto";
import type { EffectInstruction } from "../domain/effect-instruction";
/** The kbbl delivery key of an attempt's task: fixed-length, since an action id grows with its unit's path and kbbl caps keys at 300. */
export const selectDeliveryKey = (input: EffectInstruction | { readonly action_id: string; readonly seq: number }): string => {
  if ("action" in input && input.action.cause.kind === "assignment_round") return input.action.cause.round;
  const attempt = "attempt" in input ? input.attempt : input;
  return createHash("sha256").update(`${attempt.action_id}\0${attempt.seq}`).digest("hex");
};
