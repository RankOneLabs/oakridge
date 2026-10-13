import { afterEach, beforeEach, expect, it } from "vitest";

import type { Sid } from "../../lib/ids";
import { useStore } from "../../state/store";
import { makeSessionSnapshot } from "../__fixtures__/read-models";

const deleted = makeSessionSnapshot("deleted");

beforeEach(() => useStore.setState(useStore.getInitialState()));
afterEach(() => useStore.setState(useStore.getInitialState()));

it("does not invent a deletion from two empty snapshots", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().applySnapshot([]);
  expect(useStore.getState().removedSids.size).toBe(0);
});

it("remembers a session the inbox stopped listing as removed", () => {
  useStore.getState().applySnapshot([deleted]);
  useStore.getState().applySnapshot([]);
  expect(useStore.getState().removedSids.has("deleted" as Sid)).toBe(true);
});
