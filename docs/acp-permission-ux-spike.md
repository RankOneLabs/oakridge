# ACP permission UX spike

This spike answers four questions from the code as it exists on 2026-09-27. It recommends a follow-up data-model change; this cohort does not change the ACP projection.

## 1. What metadata reaches kbbl from ACP?

The local `RequestPermissionRequest` alias is the SDK type unchanged (`RequestPermissionRequest` in [`kbbl/core/acp/types.ts`](../kbbl/core/acp/types.ts)). The installed ACP schema defines three top-level fields plus extensibility metadata:

- `sessionId`;
- `toolCall`, a `ToolCallUpdate`;
- `options`, an array of `PermissionOption`;
- optional `_meta`, whose keys ACP reserves for extensions and which clients must not interpret generically.

`ToolCallUpdate` can carry `toolCallId`, `title`, programmatic `name`, `kind`, `status`, rendered `content`, `locations`, `rawInput`, `rawOutput`, and `_meta`. `kind` has protocol categories such as `read`, `edit`, `delete`, `move`, `search`, `execute`, and `fetch`. Each location has an absolute `path` and optional `line`. `rawInput` and `rawOutput` are deliberately `unknown`: their shape belongs to the tool. Each `PermissionOption` carries `optionId`, human-readable `name`, and a `kind` from `allow_once`, `allow_always`, `reject_once`, or `reject_always`.

The source of truth is the installed SDK's `RequestPermissionRequest`, `ToolCallUpdate`, `ToolCallLocation`, and `PermissionOption` types in `kbbl/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`. The repository-facing alias is `RequestPermissionRequest` in [`kbbl/core/acp/types.ts`](../kbbl/core/acp/types.ts).

## 2. What survives `projectPermissionRequest`, and what can the UI infer?

`projectPermissionRequest` in [`kbbl/core/acp/event-projector.ts`](../kbbl/core/acp/event-projector.ts) keeps:

- `toolCall.title`, with `"Permission required"` as a fallback;
- each option's `{ optionId, name, kind }`;
- kbbl's generated `requestId`.

It discards the ACP session id and tool call id, and all other tool-call metadata, including `name`, `kind`, `status`, `content`, `rawInput`, `rawOutput`, and `locations`. It also discards `_meta`, correctly, because ACP says its contents are extension-owned.

That projection is enough to show a title and answer buttons. It is insufficient for these proposed behaviors:

- **Risk classification:** a title is presentation text. Classification needs at least tool `kind` and usually the relevant paths and normalized input. An `execute` against a build command and an `execute` that changes credentials share a kind, so kind alone is not a risk decision.
- **“Is this the same low-risk request again?”:** equality needs a stable tool identity and a comparison of normalized inputs and locations. The projection has neither `toolCallId` nor the input subject. Matching titles would merge unrelated requests and would change when an agent rewords a title.
- **Grouping:** grouping requests by tool or affected resource needs `toolCallId`, `name` or `kind`, and locations. The current projection can group only by display title, which is not an identity.

The answer is therefore “not reliably” for all three. The projection removes the evidence before any PWA selector sees it.

## 3. What crosses surfaces today?

The cross-surface session snapshot carries only `pendingPermissionCount`. `PwaSessionSnapshot.pendingPermissionCount` and `toPwaSessionSnapshot` in [`kbbl/core/acp/pwa-wire.ts`](../kbbl/core/acp/pwa-wire.ts) place that integer on `/sessions` and `/inbox`; no request id, title, option, tool identity, path, or risk metadata crosses that wire.

The detailed permission card remains session-scoped. Other surfaces can say “this session has N pending permissions” and link to the existing `PendingApprovalsBadge`, but they cannot describe, deduplicate, classify, or answer an individual request from the snapshot alone. This is the right signal for the blocker toast in this cohort: it announces a rising count and points back to the session-owned durable UI.

## 4. Is an ACP permission an active cache-sensitive wait or a durable boundary?

It is active and process-local. `AcpSessionController.pendingPermissions` in [`kbbl/core/acp/controller.ts`](../kbbl/core/acp/controller.ts) is an in-memory `Map<string, PendingPermission>`. `handlePermissionRequest` inserts an unresolved Promise resolver, `resolvePermission` removes and resolves it, and `rejectPendingPermissions` cancels and clears the map on process loss. `pendingPermissionCount` is simply the map's current size. A restart loses the request and its resolver; there is no database record to resume.

A durable workflow boundary is structurally different. `Wait` in [`oakridge-dbos/src/domain/wait.ts`](../oakridge-dbos/src/domain/wait.ts) has a stable id, ownership, open/closed status, close condition, outcome, and timestamps. Migration [`oakridge-dbos/src/storage/migrations/0009_wait.sql`](../oakridge-dbos/src/storage/migrations/0009_wait.sql) persists those fields and adds uniqueness constraints for replay-safe open and close behavior. DBOS `recv` is the delivery mechanism; the wait row remains the record across process restarts.

An ACP permission should therefore stay attached to the live session and be treated as cache-sensitive active state. Promoting it to a durable workflow boundary would require a separate protocol and persistence design, including restart semantics for an agent-side Promise that no longer exists. A richer browser projection does not make the request durable.

## Recommendation

Widen `projectPermissionRequest` in a follow-up change. Add typed nullable fields for `toolCallId`, `name`, `kind`, and projected `locations`, and preserve `rawInput` as protocol-owned `unknown` for a narrowly scoped normalizer or fingerprinting step. Do not use title equality, do not interpret `_meta`, and do not add automatic approval until tool-specific normalization and risk rules exist. Keep the full detail on the session event stream; keep `/inbox` at the bare count unless a concrete cross-surface workflow needs more.

This gives future UX enough evidence to classify, compare, and group requests while preserving the existing boundary: live permissions remain per-process session state, and durable waits remain Oakridge records.
