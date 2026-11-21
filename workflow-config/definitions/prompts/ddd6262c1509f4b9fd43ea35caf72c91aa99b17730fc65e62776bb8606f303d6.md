# Revise slice

Take the paid path only when `spend_approved` and `report_is_placeholder` are both true. Otherwise take the offline path and apply the feedback. Apply free-text feedback from **Send to builder**. For an action list from **Send actions to builder**, address every `<action_id>: <text>` line and fix fixtures or tests accordingly. On change design, regenerate for the revised plan's slice. On spend request changes, revise the request. If the PR closed, replace it with a draft PR against `build_base`.

Every attempt must publish all four artifacts (`slice_build`, `spend_request`, `slice_report`, and `pr`) or it fails. The offline attempt publishes a spend request for operator approval and a placeholder report that validation deliberately refuses. After approval, that refusal brings the worker back for the paid attempt.

## Offline path

Render the approved plan to `experiments/<area>/studies/<study>/study-plan.md` using the area and study names from the spec. Raise a blocker if either name is missing. Include the question, hypotheses, case table by group with controls marked, outcomes and their rules, the ordered decision rule, model caps and expected costs with their basis, the slice and its risk reason and criteria, the paid slice, and iteration triggers. Commit the file on the slice PR branch. On a rebuild, update it from the current approved plan.

1. Generate fixtures only for the plan's `slice.case_ids`. Never generate a non-slice case.
2. Qualify the fixtures on mcclure using the qualification-host instructions below. Verify that the reference patch passes, each omission patch fails only its own fact's tests, and control cases are replayed in fresh sandboxes. Record `{case_id, reference_passes, omissions_isolated, controls_replayed, detail}` per case.
3. Compute `generator_digest` as one hash over the generator source, the shared visible tests, and the hidden-test templates. Record the exact files and hash command used so expansion can reproduce it. Commit the fixtures, generator and qualification work.
4. Publish `slice_build` as `{build: {cohort_id: "slice", title, head_sha, summary, changed_files}, generator_digest, case_ids, qualifications}`. Use the commit containing the qualified build as `build.head_sha`.
5. Write the paid slice cohort file and publish `spend_request` as `{cohort_file, attempt_count, cap_cents, generator_digest, case_ids}`. Use exactly the `slice_build` digest and case IDs because validation refuses a mismatch. Set `attempt_count` to the number of `slice_paid.models` × `slice_paid.repeats` × the number of slice cases. Set `cap_cents` at most to the plan's `slice_paid.cap_cents`. Commit the cohort file and both published artifact bodies as JSON under the study directory at `oakridge/slice-build.json` and `oakridge/spend-request.json`. The paid attempt republishes these bodies unchanged.
6. Publish an offline-only `slice_report` with `run_key: ""`, the same `generator_digest` and `qualifications`, `paid_results: []`, every plan slice criterion and iteration trigger marked `not_met` with evidence `"awaiting the paid run"`, and `proposed_changes: []`. Validation refuses this report with “No paid results yet…” by design. That refusal brings the worker back after the operator approves the spend request.
7. Push and open or update the draft PR against `build_base` using the pr-operations skill, then publish `pr`.
8. End the attempt after all four publications. Do not start a paid attempt on this path.

## Paid path

Run the paid slice on otto using the committed cohort file. Keep spend within both the approved request's cap and the plan's `slice_paid.cap_cents`. Use concurrency one and run the `docker ps` check in Hosts before launching.

Record an attempt stopped by a limit as `stopped`. Never retry or replace it. Count only attempts whose completed outcome you observed in the study store. Each paid result is `{model_id, case_id, outcome, detail, spend_cents, launch_command, store_path}`, where `outcome` is `scored`, `unscored`, or `stopped` and `launch_command` is the exact command line. Set `run_key` to this launch's store path. Include the matching generator digest and qualifications, mark every slice criterion and iteration trigger `met` or `not_met` with evidence, and list proposed changes.

Publish in this order.

1. Publish the paid `slice_report` first, provisional as soon as the observed results support it, then final. Validation accepts it only while the approved spend request is still the latest.
2. Republish `slice_build` and `spend_request` unchanged from the committed `oakridge/slice-build.json` and `oakridge/spend-request.json`.
3. Publish `pr` for the draft PR against `build_base`, using the pr-operations skill to update or replace it if needed.
4. End the attempt.

## Study specification

{{spec}}

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

## Previous artifact

{{previous}}

## Feedback

{{feedback}}

{{> study/shared/long-steps.md}}

{{> study/shared/cohort-hosts.md}}

{{> study/shared/qualification-hosts.md}}

{{> shared/raise-blocker.md}}
