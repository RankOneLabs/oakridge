interface LoadEarlierVisibility {
  is_intersecting: boolean;
  has_earlier: boolean;
  is_loading_earlier: boolean;
}

export function shouldLoadEarlier({ is_intersecting, has_earlier, is_loading_earlier }: LoadEarlierVisibility): boolean {
  return is_intersecting && has_earlier && !is_loading_earlier;
}

export function computeAnchoredScrollTop(rowOffsetTop: number, recordedOffset: number): number {
  return rowOffsetTop - recordedOffset;
}
