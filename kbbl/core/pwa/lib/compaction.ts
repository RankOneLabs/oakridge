import type { UiAvailableCommand } from "../types";
import type { UsageState } from "./acp-timeline";

export interface CompactionSuggestionInput {
  usage: UsageState | null;
  softThresholdTokens: number | null;
  commands: readonly UiAvailableCommand[];
  isDismissed: boolean;
}

/**
 * ACP agents report both live context usage and their supported commands.
 * Suggest compaction only when the current agent can actually perform it.
 */
export function shouldSuggestCompaction({
  usage,
  softThresholdTokens,
  commands,
  isDismissed,
}: CompactionSuggestionInput): boolean {
  if (
    isDismissed ||
    usage === null ||
    usage.used === null ||
    softThresholdTokens === null
  ) {
    return false;
  }
  return (
    usage.used >= softThresholdTokens &&
    commands.some((command) => command.name === "compact")
  );
}
