export interface SpecDiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/** A line diff between the stored launch spec and the published revised spec. */
export function specDiff(original: string, revised: string): readonly SpecDiffLine[] {
  const before = original.split("\n");
  const after = revised.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      lengths[left]![right] = before[left] === after[right]
        ? 1 + lengths[left + 1]![right + 1]!
        : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }
  const lines: SpecDiffLine[] = [];
  let left = 0, right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      lines.push({ kind: "same", text: before[left]! }); left++; right++;
    } else if (left < before.length && (right === after.length || lengths[left + 1]![right]! >= lengths[left]![right + 1]!)) {
      lines.push({ kind: "removed", text: before[left]! }); left++;
    } else {
      lines.push({ kind: "added", text: after[right]! }); right++;
    }
  }
  return lines;
}
