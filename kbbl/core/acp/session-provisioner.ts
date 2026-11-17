import { randomUUID } from "node:crypto";
import type { AcpSessionServiceDeps } from "#kbbl/core/acp/session-service";
import type { AcpSessionController } from "#kbbl/core/acp/controller";
import { createSessionController } from "#kbbl/core/acp/session-controller";
import { resolveProfile, type AgentProfileId } from "#kbbl/core/acp/agent-profile";
import { prepareSessionIntegration, selectDirectIntegration } from "#kbbl/core/acp/session-integration";
import { startSpecHash } from "#kbbl/core/acp/start-spec-hash";
import { toSnapshot } from "#kbbl/core/acp/pwa-wire";
import { acpError, err, isAcpFailureCode, ok, type AcpError, type AcpSessionRow, type AcpSessionSnapshot, type AcpSessionStartSpec, type AcpSessionWorkflowIdentity, type EnsureResult, type KbblSessionId, type ResumableKey, type Result, type TerminalObservation, type TurnKey } from "#kbbl/core/acp/types";

export interface SessionProvisionerCallbacks {
  touchController(sid: KbblSessionId): Promise<Result<AcpSessionController, AcpError>>;
}
const OBSERVE_POLL_MS = 100;

/** Session claims, provisioning and observation of the durable initial turn. */
export class AcpSessionProvisioner {
  constructor(private readonly deps: AcpSessionServiceDeps, private readonly callbacks: SessionProvisionerCallbacks) {}
  /**
   * Idempotent DBOS ensure. Integration and digest enter the hash so a retry
   * cannot silently change PR procedures. run_id/unit_id/worker remain
   * backfilled metadata outside the hash.
   */
  async ensureResumableSession(
    key: string,
    spec: AcpSessionStartSpec,
    identity: AcpSessionWorkflowIdentity | null = null,
  ): Promise<Result<EnsureResult, AcpError>> {
    const resumableKey = key as ResumableKey;
    const existing = identity === null ? this.deps.store.getByResumableKey(resumableKey) : null;
    const selected = identity ? ok(identity) : existing
      ? ok({ pr_integration: existing.pr_integration, pr_skill_digest: existing.pr_skill_digest })
      : selectDirectIntegration(this.deps.integration);
    if (!selected.ok) return selected;
    const specHash = startSpecHash(spec, selected.value);
    const sid = randomUUID() as KbblSessionId;
    const profileId = spec.runtime ?? this.deps.config.default_agent;

    const claimed = this.deps.store.claimResumable(resumableKey, {
      sid,
      resumable_key: resumableKey,
      start_spec_hash: specHash,
      agent_profile: profileId,
      name: spec.name ?? key,
      artifact_id: spec.artifact_id ?? null,
      project_workdir: spec.workdir,
      worktree_path: spec.workdir,
      requested_model: spec.model ?? null,
      requested_effort: spec.effort ?? null,
      requested_mode: this.profileSessionMode(profileId),
      workflow: identity,
      ...selected.value,
    });

    if (claimed.kind === "spec_conflict") {
      return err(
        acpError(
          "session_key_conflict",
          "service.ensureResumableSession",
          `resumable key "${key}" already claimed with a different start spec`,
          claimed.row.sid,
        ),
      );
    }
    if (claimed.kind === "existing") {
      const profile = resolveProfile(this.deps.profiles, claimed.row.agent_profile);
      if (!profile.ok) return profile;
      const prepared = prepareSessionIntegration(claimed.row, profile.value, this.deps.integration);
      if (!prepared.ok) return prepared;
      // Re-touch so retained accepted turns dispatch (§10.7 lazy spawn).
      if (this.hasDispatchableWork(claimed.row)) {
        void this.callbacks.touchController(claimed.row.sid);
      }
      return ok({ kind: "existing", session: toSnapshot(claimed.row) });
    }

    const provisioned = await this.provision(claimed.row, spec);
    if (!provisioned.ok) return provisioned;
    const controller = provisioned.value;

    const accepted = this.deps.store.acceptTurn({
      sid: claimed.row.sid,
      turn_key: `initial:${key}` as TurnKey,
      source: "initial",
      payload: spec.initial_prompt,
    });
    if (accepted.kind === "payload_conflict") {
      return err(
        acpError(
          "delivery_key_conflict",
          "service.ensureResumableSession",
          "initial turn already recorded with different payload",
          claimed.row.sid,
        ),
      );
    }
    // §10.2 step 13: return immediately; the initial prompt runs async.
    void controller.dispatchAcceptedTurns();
    const row = this.deps.store.getSession(claimed.row.sid);
    return ok({
      kind: "created",
      session: toSnapshot(row ?? claimed.row),
    });
  }

  /** Browser-created session (no resumable key). */
  async createSession(
    spec: AcpSessionStartSpec,
  ): Promise<Result<AcpSessionSnapshot, AcpError>> {
    const sid = randomUUID() as KbblSessionId;
    const profileId = spec.runtime ?? this.deps.config.default_agent;
    const selected = selectDirectIntegration(this.deps.integration);
    if (!selected.ok) return selected;
    const row = this.deps.store.insertSession({
      sid,
      resumable_key: null,
      start_spec_hash: null,
      agent_profile: profileId,
      name: spec.name ?? sid.slice(0, 8),
      artifact_id: spec.artifact_id ?? null,
      project_workdir: spec.workdir,
      worktree_path: spec.workdir,
      requested_model: spec.model ?? null,
      requested_effort: spec.effort ?? null,
      requested_mode: this.profileSessionMode(profileId),
      workflow: null,
      ...selected.value,
    });

    const provisioned = await this.provision(row, spec);
    if (!provisioned.ok) return provisioned;

    if (spec.initial_prompt.length > 0) {
      this.deps.store.acceptTurn({
        sid,
        turn_key: `initial:${sid}` as TurnKey,
        source: "initial",
        payload: spec.initial_prompt,
      });
      void provisioned.value.dispatchAcceptedTurns();
    }
    const fresh = this.deps.store.getSession(sid);
    return ok(toSnapshot(fresh ?? row));
  }

  /** The profile's starting permission mode; null when the profile is unknown or sets none. */
  private profileSessionMode(profileId: AgentProfileId): string | null {
    return this.deps.profiles.get(profileId)?.sessionMode ?? null;
  }

  /** §10.2 steps 3–10 for a fresh `provisioning` row. Failures become a
   * visible failed session, never an invisible claimed key. */
  private async provision(
    row: AcpSessionRow,
    spec: AcpSessionStartSpec,
  ): Promise<Result<AcpSessionController, AcpError>> {
    const profile = resolveProfile(this.deps.profiles, row.agent_profile);
    if (!profile.ok) return this.failProvisioning(row, profile.error);

    const prepared = prepareSessionIntegration(row, profile.value, this.deps.integration);
    if (!prepared.ok) return this.failProvisioning(row, prepared.error);
    const worktree = await this.deps.worktrees.resolve(row.sid, spec);
    if (!worktree.ok) return this.failProvisioning(row, worktree.error);
    this.deps.store.setWorktree(row.sid, {
      worktree_path: worktree.value.worktree_path,
      worktree_branch: worktree.value.worktree_branch,
      worktree_base_ref: worktree.value.worktree_base_ref,
      parent_sid: worktree.value.parent_sid,
      project_workdir: worktree.value.project_workdir,
    });

    const created = await this.deps.controllers.getOrCreate(row.sid, async () => {
      const controller = createSessionController({ row, profile: profile.value, deps: this.deps });
      const started = await controller.start(worktree.value.worktree_path, {
        kind: "new",
      });
      if (!started.ok) return started;
      const configured = await controller.applyRequestedConfig(row);
      if (!configured.ok) {
        await controller.closeChild();
        return configured;
      }
      return ok(controller);
    });
    if (!created.ok) return this.failProvisioning(row, created.error);

    this.deps.store.setStatus(row.sid, "idle");
    console.log(
      `[acp] sid=${row.sid} provisioned profile=${row.agent_profile} pid=${created.value.childPid}`,
    );
    return created;
  }

  private failProvisioning(
    row: AcpSessionRow,
    error: AcpError,
  ): Result<never, AcpError> {
    this.deps.store.markEnded(row.sid, {
      status: "failed",
      reason: error.code,
      detail: error.detail,
    });
    console.error(
      `[acp] sid=${row.sid} provisioning failed: ${error.code} (${error.detail})`,
    );
    return err({ ...error, sid: row.sid });
  }

  hasDispatchableWork(row: AcpSessionRow): boolean {
    return (
      row.fenced_by === null &&
      (row.status === "idle" || row.status === "prompting") &&
      this.deps.controllers.getLive(row.sid) === null &&
      this.deps.store.listAcceptedTurns(row.sid).length > 0
    );
  }

  /**
   * Bounded observation of the INITIAL turn (§11.2): pending until that
   * turn has a known final outcome; the child staying alive afterwards is
   * not non-terminal. Also the lazy-spawn touch that dispatches retained
   * accepted turns (§10.7).
   */
  async observeInitialTurn(
    sid: string,
    waitMs: number,
  ): Promise<Result<TerminalObservation, AcpError>> {
    const kbblSid = sid as KbblSessionId;
    const first = this.deps.store.getSession(kbblSid);
    if (!first) {
      return err(
        acpError(
          "session_not_found",
          "service.observeInitialTurn",
          `no session ${sid}`,
        ),
      );
    }
    if (this.hasDispatchableWork(first)) void this.callbacks.touchController(kbblSid);

    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const row = this.deps.store.getSession(kbblSid);
      if (!row) {
        return err(
          acpError(
            "session_not_found",
            "service.observeInitialTurn",
            `session ${sid} disappeared`,
          ),
        );
      }
      const observation = this.classifyInitialTurn(row);
      if (observation.kind !== "pending" || Date.now() >= deadline) {
        return ok(observation);
      }
      await new Promise((resolve) => setTimeout(resolve, OBSERVE_POLL_MS));
    }
  }

  private classifyInitialTurn(row: AcpSessionRow): TerminalObservation {
    const session = toSnapshot(row);
    if (row.status === "failed") {
      // `failProvisioning` ends the row with the failing error's own code and
      // detail, so the row already says what happened. Reporting
      // `agent_spawn_failed` for all of them threw that away at the one
      // boundary that matters: a caller watching for terminal state
      // (Oakridge's observer, the PWA) saw "the agent would not start" for a
      // session whose agent started fine and was handed a model it does not
      // offer.
      return {
        kind: "failed",
        session,
        failure_code: isAcpFailureCode(row.end_reason)
          ? row.end_reason
          : "agent_spawn_failed",
        failure_detail:
          row.end_detail ?? row.end_reason ?? "session failed during provisioning",
      };
    }
    const turn = this.deps.store.getInitialTurn(row.sid);
    // A closed/fenced session can never complete its initial turn: pending
    // here would be a wait on a state that cannot arrive. Success stays
    // success (the turn finished before the close); everything else is a
    // terminal fence/close outcome.
    if (
      (row.status === "fenced" || row.status === "ended") &&
      turn?.status !== "succeeded"
    ) {
      return {
        kind: "failed",
        session,
        failure_code: "session_fenced",
        failure_detail: `session was ${row.status} (${row.end_reason ?? "closed"}) before the initial turn completed`,
      };
    }
    if (!turn) return { kind: "pending", session };
    switch (turn.status) {
      case "succeeded":
        return { kind: "succeeded", session };
      case "failed":
      case "unknown":
        return {
          kind: "failed",
          session,
          failure_code: turn.failure_code ?? "acp_prompt_failed",
          failure_detail:
            turn.failure_detail ?? `initial turn is ${turn.status}`,
        };
      case "cancelled":
        return {
          kind: "failed",
          session,
          failure_code: "acp_prompt_failed",
          failure_detail: "initial turn was cancelled",
        };
      default:
        return { kind: "pending", session };
    }
  }
}
