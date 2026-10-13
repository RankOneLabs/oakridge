import type { ViewerProps } from "../../artifactRegistry";
import { selectFieldText, selectHttpUrl } from "../../artifact-types";
import { StatusBadge } from "../atoms/StatusBadge";
export function PrSummaryViewer({ body }: ViewerProps) {
  const url = selectHttpUrl(selectFieldText(body, "pr_url"));
  return <article className="flex flex-col gap-3" data-testid="or-pr-summary-viewer"><h3>Pull request summary</h3>
    <p>{selectFieldText(body, "summary")}</p>
    <p>Branch: <code>{selectFieldText(body, "branch")}</code></p>
    {url && <a href={url} target="_blank" rel="noopener noreferrer">Open pull request</a>}
    {selectFieldText(body, "review_status") && <StatusBadge status={selectFieldText(body, "review_status") ?? ""} />}
  </article>;
}
