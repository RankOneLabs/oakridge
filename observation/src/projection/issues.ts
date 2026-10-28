import { canonicalDigest } from "../canonical/canonical-json";

export type ExtractionIssueKind = "extraction_failed" | "no_matching_items" | "identity_collision" | "unresolved_relation";
export interface ExtractionIssue {
  readonly revision_id: string;
  readonly extractor_id: string;
  readonly extractor_version: string;
  readonly item_selector: string;
  readonly kind: ExtractionIssueKind;
  readonly detail: string;
  readonly is_retriable: boolean;
}

export function issueId(issue: ExtractionIssue): string {
  const digest = canonicalDigest([issue.revision_id, issue.extractor_id, issue.extractor_version,
    issue.item_selector, issue.kind, issue.detail]);
  if (!digest.ok) throw new Error("static issue fields must be canonical JSON");
  return digest.value;
}

/** Details are fixed labels: never echo a malformed body or parser exception. */
export function extractionIssue(revision_id: string, extractor_id: string, extractor_version: string,
  item_selector: string, kind: ExtractionIssueKind): ExtractionIssue {
  const details: Record<ExtractionIssueKind, string> = {
    extraction_failed: "artifact shape does not match the pinned selector",
    no_matching_items: "selector matched no items",
    identity_collision: "two selected items have the same occurrence identity",
    unresolved_relation: "producer reference has no eligible target in this run",
  };
  return { revision_id, extractor_id, extractor_version, item_selector, kind,
    detail: details[kind], is_retriable: kind !== "no_matching_items" };
}
