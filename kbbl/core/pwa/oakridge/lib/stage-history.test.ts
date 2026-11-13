import { expect, test } from "vitest";
import captured from "../__fixtures__/v2-adapter-sample.json";
import { sampleUnits, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import { selectIntentLinks } from "./recorded-relationships";
import { selectStageHistoryRead, selectStageHistoryRequests, selectStageRevisionIndex } from "./stage-history";

const history = captured.artifact as unknown as OperatorArtifactDetail;
const unit = sampleUnits.find((candidate) => candidate.unit_id === history.unit_id);
if (!unit) throw new Error("captured history requires its owning unit");
const artifact = unit.artifacts.find((candidate) => candidate.artifact_key === history.artifact_key);
const attempt = unit.attempts[0];
if (!artifact || !attempt) throw new Error("captured history requires its artifact and an attempt");
const selected = withUnitFields(unit, { artifacts: [artifact] });
const upstream = sampleUnits.find((candidate) => candidate.unit_id !== unit.unit_id && candidate.artifacts.length > 0);
const upstreamArtifact = upstream?.artifacts[0];
if (!upstream || !upstreamArtifact) throw new Error("captured run requires another published artifact");

test("history requests contain only the selected unit's artifacts", () => {
  expect(selectStageHistoryRequests(selected)).toEqual([{ run_id: selected.run_id, unit_id: selected.unit_id,
    artifact_key: artifact.artifact_key, revision_count: artifact.revision_count, latest_revision_id: artifact.latest_revision?.id ?? null }]);
});
test("history cache identity ignores unrelated inventory state changes", () => {
  expect(selectStageHistoryRequests(withUnitFields(selected, { input: { newly_polled: true } }))).toEqual(selectStageHistoryRequests(selected));
});
test("a unit with no output artifacts needs no history reads", () => {
  expect(selectStageHistoryRequests(withUnitFields(selected, { artifacts: [] }))).toEqual([]);
});
test("an earlier external input resolves from its recorded snapshot without reading external histories", () => {
  const snapshot = { id: "recorded-earlier-input", unit: upstream.unit_id, artifact: upstreamArtifact.artifact_key, seq: 1, body: {} };
  const withInput = withUnitFields(selected, { attempts: [{ ...attempt, intent: { inputs: { source: { revision_id: snapshot.id } },
    engine_inputs: { previous: snapshot, subject: null, feedback: [] }, prompt: null } }] });
  const index = selectStageRevisionIndex({ unit: withInput, units: sampleUnits, histories: [history] });
  const link = selectIntentLinks(index, withInput).find((link) => link.raw_reference === snapshot.id);
  expect(link?.resolution.state === "resolved" ? link.resolution.target : null).toMatchObject({
    run_id: selected.run_id, unit_id: upstream.unit_id, revision_id: snapshot.id,
    pane: { kind: "artifact", revision_id: snapshot.id, unit_id: upstream.unit_id },
  });
});
test("snapshot names cannot resolve an unrecorded unit", () => {
  const withInput = withUnitFields(selected, { attempts: [{ ...attempt, intent: { inputs: {}, engine_inputs: {
    previous: { id: "unknown-revision", unit: "unknown-unit", artifact: upstreamArtifact.artifact_key, seq: 1, body: {} }, feedback: [], subject: null }, prompt: null } }] });
  const index = selectStageRevisionIndex({ unit: withInput, units: sampleUnits, histories: [history] });
  expect(selectIntentLinks(index, withInput).map((link) => link.resolution.state)).toEqual(["unresolved"]);
});
test("the identity index includes full selected history and deduplicates latest identities", () => {
  const index = selectStageRevisionIndex({ unit: selected, units: sampleUnits, histories: [history] });
  const ids = index.revisions.map((revision) => revision.id);
  expect({ hasHistory: history.revisions.every((revision) => ids.includes(revision.id)), unique: new Set(ids).size }).toEqual({ hasHistory: true, unique: ids.length });
});
test("an unavailable history is distinct from an empty history", () => {
  expect(selectStageHistoryRead(selected, [{ data: undefined, isError: true }])).toEqual({ data: undefined, isError: true });
});
test("a failed refresh retains history that previously loaded", () => {
  expect(selectStageHistoryRead(selected, [{ data: history, isError: true }])).toEqual({ data: [history], isError: false });
});
