import { z } from "zod";

/**
 * The wire schema for `SlotBinding`, shared by every stage type that binds
 * values. Kept here rather than beside one stage type's schema so a new binding
 * variant reaches all of them at once — a definition accepted by one compiler
 * and rejected by another is a runtime failure with a definition-time cause.
 */
export const slotBindingSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), input_name: z.string().min(1), path: z.string().nullable().default(null) }),
  z.object({ from: z.literal("context"), path: z.string() }),
  z.object({ from: z.literal("literal"), value: z.string() }),
  z.object({ from: z.literal("item"), path: z.string() }),
  z.object({
    from: z.literal("context_lookup"),
    collection_path: z.string(),
    collection_key_path: z.string(),
    item_key_path: z.string(),
    value_path: z.string(),
  }),
  z.object({
    from: z.literal("input_lookup"),
    input_name: z.string().min(1),
    collection_key_path: z.string(),
    item_key_path: z.string(),
    value_path: z.string(),
  }),
]);

export const bindableSchema = z.union([z.string(), slotBindingSchema]);
