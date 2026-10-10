import type { ChipTone } from "../../components/atoms/Chip";

export function selectStatusTone(status: string): ChipTone {
  const normalized = status.toLowerCase();
  if (["complete", "completed", "approved", "succeeded", "success", "delivered"].includes(normalized)) return "success";
  if (["failed", "rejected", "error", "cancelled"].includes(normalized)) return "danger";
  if (["attention", "pending", "waiting", "parked", "draft"].includes(normalized)) return "warning";
  if (["running", "active", "started"].includes(normalized)) return "info";
  return "neutral";
}
