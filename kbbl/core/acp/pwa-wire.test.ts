import { expect, test } from "bun:test";

import { selectPwaSessionChanges, type PwaSessionSnapshot } from "./pwa-wire";

const session = (sid: string, status: PwaSessionSnapshot["status"] = "idle") =>
  ({ sid, status, workflow: null }) as PwaSessionSnapshot;

test("unchanged sessions are left out of a changes frame", () => {
  const sessions = [session("a"), session("b")];
  expect(selectPwaSessionChanges(sessions, [...sessions])).toEqual({ sessions: [], removedSids: [] });
});

test("a changed session and a new session are carried whole", () => {
  const changed = session("a", "ended"), added = session("c");
  expect(selectPwaSessionChanges([session("a"), session("b")], [changed, session("b"), added]).sessions)
    .toEqual([changed, added]);
});

test("a session no longer listed is named as removed", () => {
  expect(selectPwaSessionChanges([session("a"), session("b")], [session("b")]).removedSids).toEqual(["a"]);
});
