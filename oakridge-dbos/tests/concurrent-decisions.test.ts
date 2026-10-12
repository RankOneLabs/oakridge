import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CoreClient } from "../src/core-client/client";
import type { Event } from "../src/core-client/core-types";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { commitEvent } from "../src/storage/commit";
import { executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

async function launched(): Promise<RunId> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  return run_id;
}
const writerAction = (run_id: RunId): string => `${unitOf(run_id, "document")}:writer:Initial:Missing`;

test("a second event on a run waits for the first to commit before it reaches step", async () => {
  const run_id = await launched();
  let release_first: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release_first = resolve; });
  let signal_first: () => void = () => undefined;
  const first_in_step = new Promise<void>((resolve) => { signal_first = resolve; });
  let steps = 0;
  // The real core, with the first step held open while it owns the run row.
  const gated = { request: async (operation: "compile" | "step", input: never) => {
    if (operation === "step" && ++steps === 1) { signal_first(); await held; }
    return authority.core.request(operation, input);
  } } as unknown as CoreClient;
  const action = writerAction(run_id);
  const commit = (ingress_id: string, event: Event) => commitEvent({ db: authority.db, core: gated, wake: () => undefined },
    { run_id, ingress_id, event, writer: executor(action) });
  const first = commit("started", { kind: "worker_started", action, kbbl_session_id: "sid" });
  await first_in_step;
  const second = commit("published", { kind: "revision_published", unit: unitOf(run_id, "document"), artifact: "draft",
    body: { title: "T", body: "B" }, by: action });
  await Bun.sleep(200);
  const steps_while_held = steps;
  release_first();
  const results = await Promise.all([first, second]);
  const events = await authority.db.selectFrom("authority.event").select("ingress_id").where("run_id", "=", run_id).orderBy("created_at").execute();
  expect({ steps_while_held, steps, kinds: results.map((result) => result.ok && result.value.kind), events: events.map((event) => event.ingress_id).slice(1) })
    .toEqual({ steps_while_held: 1, steps: 2, kinds: ["committed", "committed"], events: ["started", "published"] });
});

test("concurrent events on one run serialize on the run row", async () => {
  const run_id = await launched();
  const submit = submitter(authority);
  const unit = unitOf(run_id, "document");
  const action = writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  // Each publication names no predecessor: under the run lock exactly one sees none and the rest see a stale one.
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => submit({ run_id, event: { kind: "revision_published", unit,
    artifact: "draft", body: { title: "T", body: `body ${index}` }, by: action }, writer: executor(action) })));
  const revisions = await authority.db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id).where("artifact", "=", "draft").execute();
  expect({ kinds: results.map((result) => result.ok ? result.value.kind : "error").sort(), ids: revisions.map((row) => row.id) })
    .toEqual({ kinds: ["committed", ...Array.from({ length: 7 }, () => "rejected" as const)], ids: [`${unit}:draft:1`] });
});
