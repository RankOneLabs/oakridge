/** Read contract derived from acp_turns: turn_key, created_at and payload. */
export interface ExecutedPromptTurn {
  readonly turn_id: string;
  readonly created_at: string;
  readonly text: string;
}
