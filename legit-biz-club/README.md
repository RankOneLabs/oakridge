# legit-biz-club

The workspace layer of oakridge: multi-agent collaboration over a shared artifact, built on jig (agent kit) and consumed via kbbl (operator surface).

**Status:** placeholder. No code yet. The design is in `comms/multi-agent-collab-design.md`; the v1 implementation lands in subsequent work.

When v1 ships, this directory will host:

- `Project` and `Artifact` data model
- Project-spawn command with configurable agent enrollment
- Artifact-mediated coordination protocol
- Memory commit policy and operator-driven skill commit
- Eval surface (code via executable criteria, prose via LLM-as-judge with trajectory)
- `adapters/kbbl/` — the boundary through which the workspace consumes kbbl

The conceptual term "the workspace" (per the design doc) is what this package implements. The directory name is `legit-biz-club` to avoid collision with Bun's package-management "workspaces" feature.
