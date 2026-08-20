import { z } from "zod";

import { slotBindingSchema } from "./slot-binding";

/**
 * The provisioning stage's definition-time config: where its repositories are,
 * which branch to guarantee in each, and how many it may work on at once.
 *
 * Two locations and one knob, on purpose. The entry shape is
 * `RunContextRepository` — a named type mirroring what `prepareRunContext`
 * writes — rather than a set of JSON pointers each definition gets to name
 * differently. `base_branch` sits beside the repositories rather than inside
 * each of them because a run has exactly one, and an entry that could name its
 * own was an entry that could disagree with its siblings.
 */
export const repositoryProvisioningDefinitionSchema = z.object({
  repositories: slotBindingSchema,
  base_branch: slotBindingSchema,
  max_parallel: z.number().int().positive().default(4),
});
