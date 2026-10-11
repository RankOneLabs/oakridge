import type { ChipTone } from "../../components/atoms/Chip";

export function selectStatusTone(status: string): ChipTone {
  const normalized = status.toLowerCase();
  if (["complete", "completed", "approved", "succeeded", "success", "delivered", "implementable", "met", "pass", "merged"].includes(normalized)) return "success";
  if (["failed", "rejected", "error", "blocking", "blocked", "not_met", "fail"].includes(normalized)) return "danger";
  if (["attention", "waiting", "parked", "draft", "stuck", "ambiguous", "partial", "pass_with_notes", "changes_requested", "warning"].includes(normalized)) return "warning";
  if (["running", "active", "started", "ready", "info"].includes(normalized)) return "info";
  return "muted";
}
