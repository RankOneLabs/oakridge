/**
 * Type re-exports for the PWA. The backend's src/contracts.ts is
 * the single source of truth for wire shapes AND the ``Tab`` UI
 * enum; this module exists so PWA components can keep their
 * familiar ``./lib/types`` import path while the actual definitions
 * live with the schemas.
 */
export type {
  CellDetail,
  CellEvent,
  CellSummary,
  CommitSnapshot,
  EvalScore,
  Tab,
} from "../../src/contracts";
