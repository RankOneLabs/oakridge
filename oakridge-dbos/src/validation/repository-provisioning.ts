import { z } from "zod";

import { slotBindingSchema } from "./slot-binding";

/**
 * The provisioning stage's definition-time config: where its repositories are,
 * and how many it may work on at once.
 *
 * One knob and a location, on purpose. The entry shape is `RunContextRepository`
 * — a named type mirroring what `prepareRunContext` writes — rather than a set
 * of JSON pointers each definition gets to name differently.
 */
export const repositoryProvisioningDefinitionSchema = z.object({
  repositories: slotBindingSchema,
  max_parallel: z.number().int().positive().default(4),
});
