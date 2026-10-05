# Counterexample constructs

Source: `workflow-config/definitions/dev_flow_v15.json` (read before these bundles were authored).

| Source behavior | Generic construct | Counterexample vocabulary |
| --- | --- | --- |
| analysis and planning repeat work after review inside a stage | local state transition from inspection to execution; child prerequisite graph stays acyclic | kiln, assay, rework |
| review accepts a particular published revision, invalidated by another publication | command target is an artifact revision reference; publication changes the observed revision and read version | certify_sample, specimen |
| implementation capacity remains occupied during work, interruption, review, and awaiting merge | acquire at activation; release only at terminal outcome | furnace_slot, firing, paused, inspection, dispatch |
| closed unmerged external PR allows replacement | parent tree branches on a terminal external observation, then starts a replacement worker action | shipment, returned, recast |
| initial and revised outputs use revision policies | append_revision for a ledger and replace_artifact for a current label; revision target/read versions provide predecessor pins | assay_log, current_label |

The vocabulary above is deliberately disjoint from the source flow's stage, worker, state, and command symbols. The core evaluator emits typed decisions and read/target pins; persistence must enforce those pins when it commits a publication or reserves a pool slot.
