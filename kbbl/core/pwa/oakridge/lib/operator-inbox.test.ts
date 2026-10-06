import { expect, it } from "vitest";
import { readAllInboxPages } from "./operator-inbox";
import type { OperatorInboxPage } from "../operator-contracts";

it("retains scope versions and attention across every inbox page", async () => {
  const item = { kind: "wait", run_id: "run", scope_id: "late", scope_version: 2, reason: "dependency", label: "Waiting" } as const;
  const pages: OperatorInboxPage[] = [
    { cursor: [{ scope_id: "quiet", version: 1 }], items: [], next_cursor: "late" },
    { cursor: [{ scope_id: "late", version: 2 }], items: [item], next_cursor: null },
  ];
  expect(await readAllInboxPages(async () => pages.shift()!)).toEqual({
    cursor: [{ scope_id: "quiet", version: 1 }, { scope_id: "late", version: 2 }], items: [item],
  });
});

it("fails the refresh when a later page fails instead of returning a partial inbox", async () => {
  let requests = 0;
  await expect(readAllInboxPages(async () => {
    if (++requests === 1) return { cursor: [], items: [], next_cursor: "late" };
    throw new Error("inbox unavailable");
  })).rejects.toThrow("inbox unavailable");
});
