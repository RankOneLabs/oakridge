import type { OperatorPromptVersionListing } from "../../operator-contracts/http/prompt-versions";
interface PromptVersionHistoryProps { versions: OperatorPromptVersionListing }
export function PromptVersionHistory({versions}: PromptVersionHistoryProps) {
  return <section aria-label="Versions"><h4>Versions</h4><ul>{versions.versions.map(version =>
    <li key={version.version_id}>{version.status === "pending" ? "Pending" : "Published"} · {version.version_id} · {version.source_path}{version.published_at && <> · {version.published_at}</>}{version.version_id === versions.published.version_id && " (current)"}</li>
  )}</ul></section>;
}
