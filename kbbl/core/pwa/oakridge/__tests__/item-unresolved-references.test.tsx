import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { json, panel, world } from "./item-panel-harness";
import { id, OCCURRENCE, paged } from "../__fixtures__/grading";
import type { ObservationItemOccurrenceId } from "../grading-contracts/domain/identity";
import type { ObservationUnresolvedReferenceRead } from "../grading-contracts/grading/item-reads";

beforeEach(() => { world.status = { ...world.status, links: paged([]) }; });

function reference(relation: string, occurrence_id: ObservationItemOccurrenceId = OCCURRENCE): ObservationUnresolvedReferenceRead {
  return { item: { ...world.status.item, occurrence_id }, relation_id: id(relation),
    unresolved_target_ref: `logical_item:task:${relation}`, evidence_ref: `recorded ${relation}` };
}
function mockPages(readPage: (offset: number) => Response | Promise<Response>): number[] {
  const base = vi.mocked(globalThis.fetch).getMockImplementation();
  const offsets: number[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://kbbl.test");
    if (url.pathname.endsWith("/unresolved-task-references")) {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return readPage(offset);
    }
    if (!base) throw new Error("Fixture requires the item-panel fetch harness");
    return base(input, init);
  });
  return offsets;
}

it("exhausts run pages automatically, including matches after an unrelated first page and an earlier match", async () => {
  let finish: ((response: Response) => void) | undefined;
  const unrelated = reference("same-stage-and-text", id<ObservationItemOccurrenceId>("another-occurrence"));
  const offsets = mockPages((offset) => {
    if (offset === 4) return new Promise<Response>((resolve) => { finish = resolve; });
    return json({ items: offset === 0 ? [unrelated, unrelated] : [reference("middle-page"), unrelated], total: 5, limit: 2, offset });
  });
  const onOpenTask = vi.fn();
  panel(onOpenTask);
  await waitFor(() => expect(offsets).toEqual([0, 2, 4]));
  expect(screen.getByText("Loading unresolved task references…")).toBeTruthy();
  expect(screen.queryByText("None for this item.")).toBeNull();
  if (!finish) throw new Error("Fixture requires the final page request");
  finish(json({ items: [reference("last-page")], total: 5, limit: 2, offset: 4 }));
  await waitFor(() => expect(screen.getAllByTestId("or-item-unresolved-task")).toHaveLength(2));
  const text = screen.getAllByTestId("or-item-unresolved-task").map((row) => row.textContent);
  expect(text).toEqual(["Unresolved: logical_item:task:middle-page · recorded middle-page", "Unresolved: logical_item:task:last-page · recorded last-page"]);
  expect(screen.queryByText("Loading unresolved task references…")).toBeNull();
  expect(screen.queryByRole("button", { name: /run unresolved task references/ })).toBeNull();
  expect(onOpenTask).not.toHaveBeenCalled();
});

it("reports no unresolved references only after every run page excludes this exact occurrence", async () => {
  const offsets = mockPages((offset) => json({ items: [reference("T1", id<ObservationItemOccurrenceId>("another-occurrence"))], total: 3, limit: 1, offset }));
  panel();
  await screen.findByText("None for this item.");
  expect(offsets).toEqual([0, 1, 2]);
  expect(screen.queryByTestId("or-item-unresolved-task")).toBeNull();
});

it.each(["failed", "truncated"])("reports unavailable rather than no references when a later run page is %s", async (kind) => {
  const offsets = mockPages((offset) => {
    if (offset === 0) return json({ items: [reference("unrelated", id<ObservationItemOccurrenceId>("another-occurrence"))], total: 2, limit: 1, offset });
    return kind === "failed" ? json({ error: "unavailable" }, 503) : json({ items: [], total: 2, limit: 1, offset });
  });
  panel();
  await screen.findByText("Unresolved task references unavailable.");
  expect(offsets).toEqual([0, 1]);
  expect(screen.queryByText("None for this item.")).toBeNull();
});
