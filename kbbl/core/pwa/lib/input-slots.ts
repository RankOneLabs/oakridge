import type { InputSlotDef } from "../oakridge/types";

export function updateInputSlot(
  slots: readonly InputSlotDef[],
  index: number,
  patch: Partial<InputSlotDef>,
): InputSlotDef[] {
  return slots.map((slot, slotIndex) =>
    slotIndex === index ? { ...slot, ...patch } : slot,
  );
}
