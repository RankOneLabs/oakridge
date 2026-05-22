/**
 * Type re-exports for the PWA. The backend's src/contracts.ts is
 * the single source of truth for wire shapes; this module exists
 * so PWA components can keep their familiar ``./lib/types`` import
 * path while the actual definitions live with the schemas.
 *
 * ``Tab`` is PWA-only UI state and stays here — it never crosses
 * the wire, so it doesn't belong with the backend contracts.
 */
export type {
  CellDetail,
  CellEvent,
  CellSummary,
  CommitSnapshot,
  EvalScore,
} from "../../src/contracts";

export type Tab = "events" | "artifact" | "commits" | "scores";
