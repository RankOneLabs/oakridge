import { expect, test } from "bun:test";
import { harness } from "./scope-command-fixture";

test("supported workspace command is durably accepted and replays its receipt", async () => {
  const api = await harness();
  const first = await api.submit();
  const receipt = await first.json();
  const replay = await api.submit();
  expect({ first_status: first.status, replay_status: replay.status, receipt: await replay.json(), evaluations: api.evaluationCount() })
    .toEqual({ first_status: 202, replay_status: 202, receipt, evaluations: 1 });
});

test("an undeclared workspace command has no accepted receipt", async () => {
  const api = await harness();
  const response = await api.submit({ ...api.request, command_key: "undeclared" });
  expect({ status: response.status, evaluations: api.evaluationCount() }).toEqual({ status: 422, evaluations: 0 });
});
