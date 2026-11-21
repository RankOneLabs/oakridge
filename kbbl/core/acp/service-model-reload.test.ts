import { afterEach, expect, test } from "bun:test";
import { type KbblSessionId } from "./types";
import { makeHarness, makeDirs, spec, shutdownHarnesses } from "./service-test-harness";

afterEach(shutdownHarnesses);

test("a new session records the agent's name for the model it applied", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-model-name", { ...spec(workdir), model: "fake-large" });
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;

  expect(store.getSession(ensured.value.session.sid as KbblSessionId)?.applied_model_name).toBe("Fake Large");
}, 20000);

test("a reload that offers the session's model under a new id keeps running it", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir, behavior: "load_renames_models" });

  const ensured = await service.ensureResumableSession("key-model-renamed", { ...spec(workdir), model: "fake-large" });
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  await registry.getLive(sid as KbblSessionId)!.closeChild();

  const reloaded = await service.loadHistory(sid);
  expect(reloaded.ok && reloaded.value.transcript?.live_state.config_options).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: "model", value: "fake-large-2" }),
  ]));
}, 20000);
