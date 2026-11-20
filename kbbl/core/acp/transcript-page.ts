import type { StreamEpoch, TranscriptItem } from "./transcript-model";

export interface ItemPage {
  kind: "page";
  stream_epoch: StreamEpoch;
  items: readonly TranscriptItem[];
  has_earlier: boolean;
}

export interface EpochChanged {
  kind: "epoch_changed";
  stream_epoch: StreamEpoch | null;
}

interface ItemPageInput {
  items: readonly TranscriptItem[];
  before_seq: number;
  limit: number;
}

/** Index of the first retained item at or after the cursor. */
export function lowerBoundItemSeq(items: readonly TranscriptItem[], seq: number): number {
  let start = 0;
  let end = items.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (items[middle].seq < seq) start = middle + 1;
    else end = middle;
  }
  return start;
}

export function selectItemPage({ items, before_seq, limit }: ItemPageInput): Pick<ItemPage, "has_earlier"> & { items: TranscriptItem[] } {
  const end = lowerBoundItemSeq(items, before_seq);
  const start = Math.max(0, end - limit);
  return { items: items.slice(start, end), has_earlier: start > 0 && start < end };
}
