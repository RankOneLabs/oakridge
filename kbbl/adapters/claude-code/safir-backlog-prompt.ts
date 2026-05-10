/**
 * Builds the SAFIR BACKLOG INTEGRATION block appended to the CC system
 * prompt at session-start via --append-system-prompt. Only sessions with
 * a safir task id AND a successfully-resolved project_id receive the
 * block — ad-hoc kbbl sessions get null and the spawn flow drops the flag.
 *
 * The block tells CC to file side-quests by calling the safir HTTP API
 * directly via a single POST curl (project_id is pre-resolved by the
 * spawn flow so the model never has to do a GET). The exact curl shape
 * is allowlisted in spawn.ts so it skips the kbbl PreToolUse gate.
 */

export interface SafirBacklogPromptCtx {
  taskId: number | undefined;
  projectId: string | undefined;
  sid: string;
  safirBaseUrl: string;
}

export function buildSafirBacklogPromptBlock(
  ctx: SafirBacklogPromptCtx,
): string | null {
  if (ctx.taskId === undefined) return null;
  if (ctx.projectId === undefined) return null;
  return `## SAFIR BACKLOG INTEGRATION

You are working on safir task #${ctx.taskId} (project \`${ctx.projectId}\`) in kbbl session ${ctx.sid}.

If you encounter a side-quest — a sub-problem worth tracking but NOT
worth derailing the current task for — file it to safir's backlog
instead of working on it inline or leaving a TODO comment.

File it with this exact command (pre-allowlisted shape; any deviation
will trip a permission prompt):

    curl -s -X POST ${ctx.safirBaseUrl}/tasks \\
      -H "Content-Type: application/json" \\
      -d "{\"project_id\":\"${ctx.projectId}\",\"title\":\"<short title>\",\"status\":\"backlog\",\"parent_id\":${ctx.taskId},\"notes\":\"<optional brief>\"}"

Print the \`id\` from the response so the operator can see what was filed.

Do not vary the flag order or substitute long flags (\`--silent\`);
the allowlist matches the literal command prefix up to the URL.

Stay focused on the current task.
`;
}
