import { Button } from "../../../components/atoms/Button";
import type { RecordedLink } from "../../lib/recorded-relationships";
import type { RunWorkspacePane } from "../../lib/run-workspace";

export function RelationshipLinks({ links, onOpen }: { links: readonly RecordedLink[]; onOpen: (pane: RunWorkspacePane) => void }) {
  return <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Recorded relationships">
    {links.map((link, index) => <li key={`${link.kind}:${link.raw_reference}:${index}`} data-relationship-kind={link.kind} data-link-state={link.resolution.state}>
      {link.resolution.state === "resolved"
        ? <Button variant="secondary" size="xsmall" onClick={() => { if (link.resolution.state === "resolved") onOpen(link.resolution.target.pane); }}>{link.label} · {link.raw_reference}</Button>
        : <span className="text-sm text-[var(--text-muted)]">{link.label} · {link.resolution.state === "not_captured" ? "not captured" : "unresolved"} · <code>{link.raw_reference === null ? "null" : link.raw_reference}</code></span>}
    </li>)}
  </ul>;
}
