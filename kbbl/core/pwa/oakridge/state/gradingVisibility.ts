import { create } from "zustand";

/**
 * Hiding other answers is this browser's preference and nothing more: it records nothing on any
 * server, unlocks no read and is never a decision. Reveal is always available, before any answer.
 */
export interface GradingVisibilityState {
  /** Items whose answers are shown, by selection key. Submitting reveals only its own item. */
  readonly revealed_item_keys: ReadonlySet<string>;
  /** Runs whose composites are shown. A revealed item reveals no composite. */
  readonly revealed_composite_run_ids: ReadonlySet<string>;
  revealItem: (key: string) => void;
  hideItem: (key: string) => void;
  /** Every finding an artifact shows at once; each stays individually hideable afterwards. */
  revealItems: (keys: readonly string[]) => void;
  hideItems: (keys: readonly string[]) => void;
  revealComposites: (run_id: string) => void;
  hideComposites: (run_id: string) => void;
}
const withEntry = (set: ReadonlySet<string>, entry: string): ReadonlySet<string> => new Set([...set, entry]);
const withoutEntry = (set: ReadonlySet<string>, entry: string): ReadonlySet<string> => new Set([...set].filter((candidate) => candidate !== entry));
export const useGradingVisibility = create<GradingVisibilityState>()((set) => ({
  revealed_item_keys: new Set(),
  revealed_composite_run_ids: new Set(),
  revealItem: (key) => set((state) => ({ revealed_item_keys: withEntry(state.revealed_item_keys, key) })),
  hideItem: (key) => set((state) => ({ revealed_item_keys: withoutEntry(state.revealed_item_keys, key) })),
  revealItems: (keys) => set((state) => ({ revealed_item_keys: new Set([...state.revealed_item_keys, ...keys]) })),
  hideItems: (keys) => set((state) => ({ revealed_item_keys: new Set([...state.revealed_item_keys].filter((key) => !keys.includes(key))) })),
  revealComposites: (run_id) => set((state) => ({ revealed_composite_run_ids: withEntry(state.revealed_composite_run_ids, run_id) })),
  hideComposites: (run_id) => set((state) => ({ revealed_composite_run_ids: withoutEntry(state.revealed_composite_run_ids, run_id) })),
}));
