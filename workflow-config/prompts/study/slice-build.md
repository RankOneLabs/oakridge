# Slice builder

Build and qualify the slice offline, then request approval for paid validation.

Every attempt must publish all four artifacts (`slice_build`, `spend_request`, `slice_report`, and `pr`) or it fails. The offline attempt publishes a spend request for operator approval and a placeholder report that validation deliberately refuses. After approval, that refusal brings the worker back for the paid attempt.

## Offline path

1. Generate fixtures only for the plan's `slice.case_ids`. Never generate a non-slice case.
2. Qualify the fixtures on mcclure using the qualification-host instructions below. Verify that the reference patch passes, each omission patch fails only its own fact's tests, and control cases are replayed in fresh sandboxes. Record `{case_id, reference_passes, omissions_isolated, controls_replayed, detail}` per case.
3. Compute `generator_digest` as one hash over the generator source, the shared visible tests, and the hidden-test templates. Record the exact files and hash command used so expansion can reproduce it. Commit the fixtures, generator and qualification work.
4. Publish `slice_build` as `{build: {cohort_id: "slice", title, head_sha, summary, changed_files}, generator_digest, case_ids, qualifications}`. Use the commit containing the qualified build as `build.head_sha`.
5. Write the paid slice cohort file and publish `spend_request` as `{cohort_file, attempt_count, cap_cents, generator_digest, case_ids}`. Use exactly the `slice_build` digest and case IDs because validation refuses a mismatch. Set `attempt_count` to the number of `slice_paid.models` × `slice_paid.repeats` × the number of slice cases. Set `cap_cents` at most to the plan's `slice_paid.cap_cents`. Commit the cohort file and both published artifact bodies as JSON under the study directory at `oakridge/slice-build.json` and `oakridge/spend-request.json`. The paid attempt republishes these bodies unchanged.
6. Publish an offline-only `slice_report` with `run_key: ""`, the same `generator_digest` and `qualifications`, `paid_results: []`, every plan slice criterion and iteration trigger marked `not_met` with evidence `"awaiting the paid run"`, and `proposed_changes: []`. Validation refuses this report with “No paid results yet…” by design. That refusal brings the worker back after the operator approves the spend request.
7. Push and open or update the draft PR against `build_base` using the pr-operations skill, then publish `pr`.
8. End the attempt after all four publications. Do not start a paid attempt on this path.

## Approved study plan

{{plan}}

## Repository

{{repository}}

## Build base

{{build_base}}

## Spend approved

{{spend_approved}}

## Report is a placeholder

{{report_is_placeholder}}

## Long steps

- Publish a provisional artifact as soon as the work supports it, and publish again with the final numbers.
- Run long commands in the foreground with a polling wait (for example a loop that checks a log or status every 30–60 seconds until done). Never leave a command running in the background across turns.
- Before starting any long step, check that this attempt is still running. If it is not, stop.
- Never end your turn before every artifact this step must publish has been published. Ending early fails the attempt.

## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). Use mcclure for that work.
- Run every paid cohort of this study, including the pilot, on otto, where the evaluator Docker runtime and study store live. Never move a cohort to another machine.
- Before launching any paid cohort, run `docker ps` on otto. Wait for any qualification containers to finish and check again before launching. Never launch beside them. Use concurrency one.

## Qualification hosts

- Qualification runs on mcclure, never otto, with at most two scenarios at once.
- Per run:
  1. Image: `docker save <evaluator image> | ssh mcclure docker load`. Then `ssh mcclure docker image inspect <evaluator image> | jq -r '.[0].Id'` must equal the pinned image digest; stop otherwise.
  2. Code: over `ssh -A mcclure`, clone or `git pull --ff-only` the study branch into ~/apps/assay. Run `uv sync --locked --group dev` in ~/apps/assay/experiments. Regenerate, and check the tree digest equals the builder's.
  3. Logs: under ~/study-runs/<study>/ on mcclure, never under /tmp. A wake power-cycles mcclure and wipes /tmp.
  4. Results: commit on mcclure and push back over git with the forwarded agent (`ssh -A`). Never copy fixtures or results with scp.
- A connection timeout means mcclure suspended on idle. Wake it with `POST willie:8900/machines/mcclure/wake` and poll `GET willie:8900/machines` until it leaves `waking`.
- mcclure shuts down only after 30 minutes with no work, so a long qualification run is safe once started.

If the inputs are contradictory, unimplementable or ambiguous in a way only the operator can settle, raise a blocker instead of guessing.
