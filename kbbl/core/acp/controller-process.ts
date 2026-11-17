import type * as schema from "@agentclientprotocol/sdk";
import type { ControllerDeps, ControllerStartMode, RequestedSessionConfig } from "#kbbl/core/acp/controller";
import { matchRequestedOption, resolveRequestedOption } from "#kbbl/core/acp/config-option-resolver";
import { resolveExternalGitDir } from "#kbbl/core/session/worktree";
import { AcpClient } from "#kbbl/core/acp/client";
import type { AcpChildProcess } from "#kbbl/core/acp/process-supervisor";
import { projectConfigOptions } from "#kbbl/core/acp/event-projector";
import { AcpUsageCapture } from "#kbbl/core/acp/usage-capture";
import { acpError, err, ok, type AcpAgentSessionId, type AcpError, type AcpUiEvent, type Result } from "#kbbl/core/acp/types";

export interface ControllerProcessCallbacks {
  emit(event: AcpUiEvent): void;
  update(notification: schema.SessionNotification): void;
  permission(request: schema.RequestPermissionRequest): Promise<schema.RequestPermissionResponse>;
  exit(code: number): void;
}

/** ACP process lifecycle and its process-local configuration cache. */
export class AcpControllerProcess {
  child: AcpChildProcess | null = null;
  client: AcpClient | null = null;
  acpSessionId: AcpAgentSessionId | null = null;
  configOptions: readonly schema.SessionConfigOption[] = [];
  replaying = false;
  defunct = false;
  readonly usage: AcpUsageCapture;
  constructor(private readonly deps: ControllerDeps, private readonly callbacks: ControllerProcessCallbacks) {
    this.usage = new AcpUsageCapture(deps);
  }
  async start(
    cwd: string,
    mode: ControllerStartMode,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, AcpError>> {
    if (abortSignal?.aborted) {
      return err(
        acpError(
          "acp_session_load_failed",
          "controller.start",
          "cold history load was cancelled",
          this.deps.sid,
        ),
      );
    }
    // A linked worktree's git data lives outside cwd; granting it as a
    // workspace root lets a sandboxed agent commit without asking. Resolved
    // before the spawn: an await between initialize and session/new|load
    // would open a window where a cancel's teardown nulls the client.
    const integration = this.deps.prepareIntegration?.() ?? ok({ mcpServers: [], skillDirectory: null });
    if (!integration.ok) return integration;
    const externalGitDir = await resolveExternalGitDir(cwd);
    const additionalDirectories = externalGitDir === null ? [] : [externalGitDir];
    if (integration.value.skillDirectory !== null) additionalDirectories.push(integration.value.skillDirectory);
    this.usage.beginProcess();
    const spawned = this.deps.supervisor.spawn(this.deps.profile, cwd);
    if (!spawned.ok) return spawned;
    this.child = spawned.value;
    this.child.onExit((code) => this.callbacks.exit(code));
    if (abortSignal?.aborted) {
      await this.teardownChild();
      return err(
        acpError(
          "acp_session_load_failed",
          "controller.start",
          "cold history load was cancelled",
          this.deps.sid,
        ),
      );
    }
    abortSignal?.addEventListener(
      "abort",
      () => {
        void this.teardownChild().catch((error: unknown) => {
          console.error(
            `[acp] sid=${this.deps.sid} cancelled child teardown failed`,
            error,
          );
        });
      },
      { once: true },
    );

    this.client = new AcpClient(this.deps.sid, this.child, {
      onSessionUpdate: (notification) => this.callbacks.update(notification),
      onPermissionRequest: (request) => this.callbacks.permission(request),
    }, integration.value.mcpServers);

    const initialized = await this.client.initialize();
    if (!initialized.ok) {
      await this.teardownChild();
      return initialized;
    }
    if (integration.value.skillDirectory !== null && this.client.agentCapabilities.sessionCapabilities?.additionalDirectories == null) {
      await this.teardownChild();
      return err(acpError("skill_unavailable", "controller.start", `${this.deps.profile.id} does not advertise the verified skill discovery path`, this.deps.sid));
    }
    if (
      this.deps.profile.requireLoadSession &&
      this.client.agentCapabilities.loadSession !== true
    ) {
      await this.teardownChild();
      return err(
        acpError(
          "acp_required_capability_missing",
          "controller.start",
          `profile "${this.deps.profile.id}" requires session/load but the agent does not advertise loadSession`,
          this.deps.sid,
        ),
      );
    }

    if (mode.kind === "new") {
      const created = await this.client.newSession(cwd, additionalDirectories);
      if (!created.ok) {
        await this.teardownChild();
        return created;
      }
      this.acpSessionId = created.value.sessionId as AcpAgentSessionId;
      this.configOptions = created.value.configOptions ?? [];
      this.deps.store.setAcpSessionId(this.deps.sid, this.acpSessionId);
      if (this.configOptions.length > 0) {
        this.callbacks.emit(projectConfigOptions(this.configOptions));
      }
      return ok(undefined);
    }

    this.acpSessionId = mode.acp_session_id;
    this.replaying = true;
    const loaded = await this.client.loadSession(
      mode.acp_session_id,
      cwd,
      additionalDirectories,
    );
    this.replaying = false;
    if (!loaded.ok) {
      await this.teardownChild();
      return loaded;
    }
    // session/load answers with configOptions like session/new does; a
    // respawned session must keep the §12 resolver cache and the UI's
    // config selectors alive across child restarts.
    const loadedOptions = loaded.value?.configOptions ?? [];
    if (loadedOptions.length > 0) {
      this.configOptions = loadedOptions;
      this.callbacks.emit(projectConfigOptions(loadedOptions));
    }
    return ok(undefined);
  }

  async applyRequestedConfig(
    requested: RequestedSessionConfig,
  ): Promise<Result<void, AcpError>> {
    const requests: Array<["model" | "thought_level", string | null]> = [
      ["model", requested.requested_model],
      ["thought_level", requested.requested_effort],
    ];
    for (const [category, value] of requests) {
      const resolved = resolveRequestedOption(this.configOptions, category, value);
      if (!resolved.ok) return resolved;
      if (resolved.value === null) continue;
      // Any match that is not exact changed what will run, and nothing else
      // can tell the operator: the picker showed one id and the session got
      // another.
      const match = resolved.value.match;
      const prefix =
        `[acp] sid=${this.deps.sid} ${category} requested=${value} ` +
        `resolved=${resolved.value.valueId} `;
      if (match.kind === "context_hint_ignored") {
        console.log(
          prefix +
            `context_hint_ignored requested_hint=${match.requestedHint ?? "none"} ` +
            `matched_hint=${match.matchedHint ?? "none"}`,
        );
      } else if (match.kind === "retired_id_mapped") {
        console.log(prefix + `retired_id_mapped retired_id=${match.retiredId}`);
      }
      const applied = await this.setConfigOption(
        resolved.value.configId,
        resolved.value.valueId,
      );
      if (!applied.ok) return applied;
    }
    return this.applyRequestedMode(requested.requested_mode);
  }

  private async applyRequestedMode(
    requestedMode: string | null,
  ): Promise<Result<void, AcpError>> {
    if (requestedMode === null) return ok(undefined);
    const resolved = matchRequestedOption(this.configOptions, "mode", requestedMode);
    if (!resolved.ok) {
      console.warn(
        `[acp] sid=${this.deps.sid} mode requested=${requestedMode} not applied: ${resolved.error}`,
      );
      return ok(undefined);
    }
    const current = this.configOptions.find(
      (option) => option.id === resolved.value.configId,
    );
    if (current?.currentValue === resolved.value.valueId) return ok(undefined);
    const applied = await this.setConfigOption(
      resolved.value.configId,
      resolved.value.valueId,
    );
    if (!applied.ok) {
      console.warn(
        `[acp] sid=${this.deps.sid} mode requested=${requestedMode} not applied: ${applied.error.detail}`,
      );
    }
    return ok(undefined);
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<Result<void, AcpError>> {
    const client = this.client;
    if (!client || this.acpSessionId === null) {
      return err(this.notLiveError("controller.setConfigOption"));
    }
    const applied = await client.setConfigOption(
      this.acpSessionId,
      configId,
      value,
    );
    if (!applied.ok) return applied;
    this.configOptions = applied.value.configOptions;
    this.callbacks.emit(projectConfigOptions(this.configOptions));
    return ok(undefined);
  }

  async closeSessionBounded(client: AcpClient): Promise<void> {
    if (!client.agentCapabilities.sessionCapabilities?.close) return;
    if (this.acpSessionId === null) return;
    await Promise.race([
      client.closeSession(this.acpSessionId),
      new Promise((resolve) =>
        setTimeout(resolve, this.deps.config.close_grace_ms),
      ),
    ]);
  }

  async teardownChild(): Promise<void> {
    this.defunct = true;
    this.client?.close();
    this.client = null;
    if (this.child) {
      await this.child.kill();
      this.child = null;
    }
  }

  notLiveError(operation: string): AcpError {
    return acpError(
      "acp_transport_lost",
      operation,
      "no live ACP connection for this controller",
      this.deps.sid,
    );
  }
}
