# Expansion unit

Generate and qualify exactly `case_ids`, this group's non-slice cases, with the approved slice's generator on mcclure. Follow the qualification-host instructions below.

Check that the reference patch passes, each omission patch fails only its own fact's tests, and control cases are replayed in fresh sandboxes. Record `{case_id, reference_passes, omissions_isolated, controls_replayed, detail}` per case. Recompute the digest using the same files and hash command as the slice build. It must equal `generator_digest`.

Preserve the generator source, shared visible tests, and hidden-test templates. If the cases need any of those files changed to qualify, publish a blocker that states the needed change and why. The operator then relaunches the study with the approved plan.

Commit the qualified expansion and publish `expansion` as `{build: {cohort_id: group_id, title, head_sha, summary, changed_files}, generator_digest, case_ids, qualifications}`. The published case IDs must be exactly the supplied `case_ids`. Validation refuses a digest or case-ID mismatch.

Use the pr-operations skill to push and open or update the draft PR against `build_base`, then publish `pr`.

## Group ID

{{group_id}}

## Expansion case IDs

{{case_ids}}

## Approved generator digest

{{generator_digest}}

## Study plan

{{plan}}

## Repository

{{repository}}

## Build base

{{build_base}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). otto runs the paid cohorts. Use mcclure for that work.

## Qualification hosts

- Qualification runs on mcclure, never otto, with at most two scenarios at once.
- Per run:
  1. Image: `docker save <evaluator image> | ssh mcclure docker load`. Then `ssh mcclure docker image inspect <evaluator image> | jq -r '.[0].Id'` must equal the pinned image digest; stop otherwise.
  2. Code: over `ssh -A mcclure`, use a dedicated checkout under `~/study-runs/<study>/<group-id>/<branch-hash>/assay`. Use safe directory components and compute `branch-hash` as the SHA-256 of the exact expansion branch name so simultaneous groups or study runs have distinct checkouts. Push the expansion branch before remote qualification, then clone it there or fast-forward the same branch in its existing checkout. Use its `experiments/` directory for `uv sync --locked --group dev`, regeneration, and qualification. Check the tree digest equals the builder's.
  3. Logs: beside the dedicated checkout under `~/study-runs/<study>/<group-id>/<branch-hash>/` on mcclure, never under /tmp. A wake power-cycles mcclure and wipes /tmp.
  4. Results: commit on mcclure and push back over git with the forwarded agent (`ssh -A`). Never copy fixtures or results with scp.
- A connection timeout means mcclure suspended on idle. Wake it with `POST willie:8900/machines/mcclure/wake` and poll `GET willie:8900/machines` until it leaves `waking`.
- mcclure shuts down only after 30 minutes with no work, so a long qualification run is safe once started.

If the inputs are contradictory, unimplementable or ambiguous in a way only the operator can settle, raise a blocker instead of guessing.
