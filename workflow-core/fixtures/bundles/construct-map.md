# Counterexample constructs

Source: `workflow-config/definitions/dev_flow_v15.json` (read before these bundles were authored).

| Source behavior | Generic construct | Counterexample vocabulary |
| --- | --- | --- |
| analysis and planning repeat work after review inside a stage | local state transition from inspection to execution; child prerequisite graph stays acyclic | kiln, assay, rework |
| review accepts a particular published revision, invalidated by another publication | command carries the requested revision and compares it with the observed output; a later publication rejects the old request | certify_sample, specimen |
| implementation capacity remains occupied during work, interruption, review, and awaiting merge | branch on declared pool occupancy before acquire; hold through intermediate phases; release only at terminal outcome | furnace_slot, firing, paused, inspection, dispatch |
| closed unmerged external PR allows replacement | parent tree branches on a terminal external observation, then starts a replacement worker action | shipment, returned, recast |
| initial and revised outputs use revision policies | append_revision for a ledger and replace_artifact for a current label; command carries both predecessors and rejects either stale reference; target/read versions pin the accepted observation | assay_log, current_label |

The vocabulary above is deliberately disjoint from the source flow's stage, worker, state, and command symbols. The evaluator rejects stale review requests, either stale publication predecessor, and activation against an occupied one-slot pool using declared payloads, resources, and decision-tree guards. The occupancy observation is derived from the declared furnace_slot reservation count, not a caller-supplied availability flag. Persistence must supply that authoritative observation and atomically validate read pins when committing publication or pool mutations; these fixtures do not claim to test concurrent commit enforcement.
