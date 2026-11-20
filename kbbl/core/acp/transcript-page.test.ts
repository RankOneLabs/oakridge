import { expect, test } from "bun:test";
import { selectItemPage } from "./transcript-page";
import { transcriptItemId, transcriptSeq, type TranscriptItem } from "./transcript-model";

const items = Array.from({ length: 100 }, (_, index): TranscriptItem => {
  const seq = transcriptSeq(index);
  return { kind: "user_message", seq, id: transcriptItemId(seq), text: String(index), message_id: null, turn_key: null, is_replayed: false };
});

test("returns the nearest items strictly below the cursor in sequence order", () => {
  expect(selectItemPage({ items, before_seq: 50, limit: 10 })).toEqual({
    items: items.slice(40, 50), has_earlier: true,
  });
});

test("consecutive pages meet without overlap or gaps and stop at the first retained item", () => {
  const newer = selectItemPage({ items, before_seq: 15, limit: 10 });
  const older = selectItemPage({ items, before_seq: newer.items[0].seq, limit: 10 });
  expect([...older.items, ...newer.items]).toEqual(items.slice(0, 15));
  expect(older.has_earlier).toBe(false);
  expect(selectItemPage({ items, before_seq: older.items[0].seq, limit: 10 })).toEqual({ items: [], has_earlier: false });
});
