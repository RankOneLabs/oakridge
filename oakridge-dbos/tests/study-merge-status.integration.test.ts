import { expect, test } from "bun:test";
import { openAuthority } from "./authority-fixture";
import { decodeWorkflowSource } from "../src/core-client/source-types";
import { assessment, expansion, freeze, item, openStudy, paid, plan, pr, prepareSlice, sliceAssessment, sliceBuild, studySource } from "./study-fixture";

test("merge status follows the inspection's source when the external reference is renamed", async () => {
  const source = decodeWorkflowSource(JSON.parse(JSON.stringify(studySource)
    .replaceAll('"pr"', '"change_reference"')
    .replace(/\(pr(?=[),])/g, "(change_reference")
    .replaceAll('"change_reference":"latest(change_reference)', '"pr":"latest(change_reference)')));
  if (!source) throw new Error("Invalid renamed study");
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority, { source });
    await run.code("git", run.unit("repository_setup/oakridge"));
    await run.publish("designer", "plan", plan);
    await run.end("designer");
    expect((await run.decide("plan_review", "accept", "plan")).status).toBe(201);
    await run.publish("slice_builder", "slice_build", sliceBuild);
    await run.publish("slice_builder", "change_reference", pr("slice", 1));
    expect(await (await run.request("GET", "/merge-status")).json())
      .toMatchObject({ kind: "merged", pr_url: pr("slice", 1).change_request_link });
  } finally { await authority.close(); }
});

test("merge status uses the watch intent on design, expansion, freeze and integration", async () => {
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority);
    async function check(location: string, number: number) {
      const response = await run.request("GET", "/merge-status", undefined, undefined, location);
      expect(await response.json()).toMatchObject({ kind: "merged", pr_url: pr("irrelevant", number).change_request_link });
    }
    const request = await prepareSlice(run);
    await run.end("spend_requester");
    await check(run.unit(), 1);
    expect((await run.decide("spend_request_review", "approve", "spend_request")).status).toBe(201);
    const runner = await run.startRunner();
    const report = await run.publish("slice_runner", "slice_report", paid(runner.key), { subject: request.id });
    await run.end("slice_runner");
    await run.publish("slice_assessor", "slice_assessment", sliceAssessment(runner.key), { subject: report.id });
    await run.end("slice_assessor");
    expect((await run.decide("slice_assessment_review", "approve_assessment", "slice_assessment", { assessed_revision: report.id, dispositions: [] })).status).toBe(201);
    expect((await run.decide("slice_report_review", "expand", "slice_report")).status).toBe(201);
    expect((await run.decide("merge_confirmation", "confirm_merged", "pr")).status).toBe(201);

    for (const [index, group] of ["two", "three"].entries()) {
      const location = run.unit(`expansion/${group}`);
      const work = await run.publish("expander", "expansion", expansion(group, [group]), { location });
      await run.publish("expander", "pr", pr(group, index + 2), { location });
      await run.end("expander", location);
      await check(location, index + 2);
      await run.publish("assessor", "assessment", assessment(group, [item("case", group)]), { subject: work.id, location });
      await run.end("assessor", location);
      expect((await run.decide("expansion_review", "accept", "assessment", { assessed_revision: work.id, dispositions: [] }, location)).status).toBe(201);
      expect((await run.decide("merge_confirmation", "confirm_merged", "pr", { payload: {} }, location)).status).toBe(201);
    }
    const freezer = run.unit("freeze");
    await run.publish("freezer", "freeze", freeze, { location: freezer });
    await run.publish("freezer", "pr", pr("freeze", 4), { location: freezer });
    await run.end("freezer", freezer);
    await check(freezer, 4);
    await run.code("pr_watch", freezer);
    expect((await run.decide("freeze_review", "ask_for_revision", "freeze", { payload: { feedback: "Confirm manifests" } }, freezer)).status).toBe(201);
    await run.publish("freezer", "freeze", freeze, { location: freezer });
    await run.publish("freezer", "pr", pr("freeze", 4), { location: freezer });
    await run.end("freezer", freezer);
    await check(freezer, 4);
    await run.code("pr_watch", freezer);
    await run.code("prepare_observed_state", freezer);
    expect((await run.decide("freeze_review", "accept", "freeze", { payload: {} }, freezer)).status).toBe(201);
    const integration = run.unit("integration");
    const integrated = await run.publish("integrator", "pr", pr("integration", 5), { location: integration });
    await run.publish("integrator", "assessment", assessment("integration", [
      ...plan.cases.map((entry) => item("case", entry.id)), item("cohort_file", "full"),
    ]), { location: integration, subject: integrated.id });
    await run.end("integrator", integration);
    await check(integration, 5);
  } finally { await authority.close(); }
});
