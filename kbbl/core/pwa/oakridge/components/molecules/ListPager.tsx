import { Button } from "../../../components/atoms/Button";
import type { ObservationPageRequest, ObservationPaged } from "../../grading-contracts/grading/composite";

interface Props {
  name: string;
  page: Pick<ObservationPaged<unknown>, "total" | "limit" | "offset">;
  onWindow: (window: ObservationPageRequest) => void;
}

/** Continuation for one list. Each returned list carries its own, so none can end silently early. */
export function ListPager({ name, page, onWindow }: Props) {
  if (page.total <= page.limit && page.offset === 0) return null;
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.limit, page.total);
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]" data-testid={`or-pager-${name}`}>
      <span>{first}–{last} of {page.total}</span>
      <Button variant="secondary" size="xsmall" className="text-xs!" disabled={page.offset === 0} aria-label={`Previous ${name}`}
        onClick={() => onWindow({ limit: page.limit, offset: Math.max(0, page.offset - page.limit) })}>Previous</Button>
      <Button variant="secondary" size="xsmall" className="text-xs!" disabled={last >= page.total} aria-label={`More ${name}`} data-testid={`or-pager-${name}-next`}
        onClick={() => onWindow({ limit: page.limit, offset: page.offset + page.limit })}>More</Button>
    </div>
  );
}
