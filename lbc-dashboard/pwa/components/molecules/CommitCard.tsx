/**
 * One snapshot card in the commits view. Shows the per-commit
 * filename header + the raw content as a preformatted block.
 * No diff yet — that's a richer view we'll add when comparing
 * commits matters.
 */
import type { CommitSnapshot } from "../../lib/types";

export function CommitCard({ commit }: { commit: CommitSnapshot }) {
  return (
    <li className="mb-6">
      <h3 className="text-sm text-stone-600">{commit.filename}</h3>
      <pre className="overflow-auto bg-stone-50 p-3 text-[12px]">
        {commit.content}
      </pre>
    </li>
  );
}
