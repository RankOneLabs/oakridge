import type { TurnKey } from "./acp/types";

/** Read contract derived from acp_turns: turn_key, created_at and payload. */
export interface ExecutedPromptTurn {
  readonly turn_id: TurnKey;
  readonly created_at: string;
  readonly text: string;
}
