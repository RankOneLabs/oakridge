import type { AtomEdit } from "./types";

/**
 * Returns the latest edit value for the given anchor, or asEmitted if
 * no edit exists. Scans from newest to oldest so the first match wins.
 */
export function liveValueAt(
  edits: AtomEdit[],
  anchor: string | null,
  asEmitted: string,
): string {
  for (let i = edits.length - 1; i >= 0; i--) {
    if (edits[i].anchor === anchor) {
      return edits[i].new_value;
    }
  }
  return asEmitted;
}
