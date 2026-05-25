// AUTO-GENERATED — do not edit by hand.
// Regenerate with: codex app-server generate-ts --out kbbl/adapters/codex/protocol/generated --experimental
// Source: codex-cli 0.133.0

export type SandboxMode =
  | "danger-full-access"
  | "workspace-write"
  | "network-disabled"
  | "full-isolation";

export type ApprovalPolicy = "never" | "untrusted" | "on-request" | "always";

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface CodexThread {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string };
  path: string;
  cwd: string;
  cliVersion: string;
  source: string;
  threadSource: unknown;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown;
  name: string | null;
  turns: unknown[];
}

export interface CodexTurn {
  id: string;
  items: unknown[];
  itemsView: string;
  status: TurnStatus;
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface SandboxPolicy {
  type: string;
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface TurnInputItem {
  type: "text";
  text: string;
  text_elements?: unknown[];
}

// === Client → Server requests ===

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean };
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartParams {
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  model?: string;
  runtimeWorkspaceRoots?: string[];
}

export interface ThreadStartResult {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  serviceTier: unknown;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  instructionSources: unknown[];
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
  activePermissionProfile: unknown;
  reasoningEffort: unknown;
}

export type ThreadForkResult = ThreadStartResult;

export interface ThreadForkParams {
  threadId: string;
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  runtimeWorkspaceRoots?: string[];
}

export interface ThreadUnsubscribeParams {
  threadId: string;
}

export interface ThreadUnsubscribeResult {
  status: "unsubscribed";
}

export interface TurnStartParams {
  threadId: string;
  input: TurnInputItem[];
}

export interface TurnStartResult {
  turn: CodexTurn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type ModelListResult = Array<{ id: string; label?: string }>;

// === Server → Client notifications ===

export interface ThreadStartedParams {
  thread: CodexThread;
}

export interface TurnStartedParams {
  threadId: string;
  turn: CodexTurn;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: CodexTurn;
}

export interface ItemStartedParams {
  item: unknown;
  threadId: string;
  turnId: string;
  startedAtMs: number;
}

export interface ItemCompletedParams {
  item: unknown;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

export interface ItemAgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TokenUsageTotals {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TokenUsage {
  total: TokenUsageTotals;
  last: TokenUsageTotals;
  modelContextWindow: number;
}

export interface ThreadTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: TokenUsage;
}

export interface ThreadStatusChangedParams {
  threadId: string;
  status: { type: string; activeFlags?: string[] };
}

// === Server → Client server-requests (approval) ===

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason: string | null;
  grantRoot: string | null;
}

export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason: string | null;
  command: string;
  cwd: string;
  commandActions: unknown[];
  proposedExecpolicyAmendment: unknown[];
  availableDecisions: unknown[];
}

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown[] } }
  | { applyNetworkPolicyAmendment: unknown }
  | "decline"
  | "cancel";
