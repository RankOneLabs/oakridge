import type { Result } from "../../lib/result";

/** Whether an operator's edit was saved; a failure carries the message to show beside the field. */
export type EditOutcome = Result<void, string>;

/** Settles a save into an outcome, so an editor can keep its draft when the save fails. */
export function settleEdit(save: Promise<unknown>): Promise<EditOutcome> {
  return save.then(
    (): EditOutcome => ({ ok: true, value: undefined }),
    (error: unknown): EditOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
}
