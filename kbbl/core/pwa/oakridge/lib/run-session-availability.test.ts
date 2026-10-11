import { afterEach, beforeEach, expect, it } from "vitest";

import type { Sid } from "../../lib/ids";
import { useStore } from "../../state/store";
import { makeSessionSnapshot } from "../__fixtures__/read-models";

const legacy = makeSessionSnapshot("legacy", { source: "legacy_archive", name: "Archived attempt" });
const deleted = makeSessionSnapshot("deleted");
const session = (sid: string) => useStore.getState().sessions.get(sid as Sid);

beforeEach(() => useStore.setState(useStore.getInitialState()));
afterEach(() => useStore.setState(useStore.getInitialState()));

it("preserves a delayed legacy archive seed after an empty live snapshot", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().seedSessions([legacy]);
  expect(session("legacy")?.name).toBe("Archived attempt");
  expect(useStore.getState().removedSids.has("legacy" as Sid)).toBe(false);
});

it("preserves a legacy archive entry when the live snapshot arrives later", () => {
  useStore.getState().seedSessions([legacy]);
  useStore.getState().applySnapshot([]);
  expect(session("legacy")?.source).toBe("legacy_archive");
});

it("records a successful empty archive seed independently of an empty live snapshot", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().seedSessions([]);
  expect(useStore.getState().hasSessionSeed).toBe(true);
  expect(useStore.getState().sessions.size).toBe(0);
});

it("does not invent a deletion while the archive request is still pending", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().applySnapshot([]);
  expect(useStore.getState().removedSids.size).toBe(0);
});

it("remembers an observed ACP removal while the archive seed is pending", () => {
  useStore.getState().applySnapshot([deleted]);
  useStore.getState().applySnapshot([]);
  expect(useStore.getState().removedSids.has("deleted" as Sid)).toBe(true);
});
