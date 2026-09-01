// Thin wrapper around @agentclientprotocol/sdk (§8.3). This is the IO
// boundary for the protocol: every fallible operation catches at the SDK
// edge and returns a Result. It forwards session/update notifications and
// permission requests to the controller via callbacks and never interprets
// provider-private payloads.

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";

import type { AcpChildProcess } from "./process-supervisor";
import {
  acpError,
  err,
  ok,
  type AcpError,
  type AcpFailureCode,
  type KbblSessionId,
  type Result,
} from "./types";

export interface AcpClientHandlers {
  onSessionUpdate(notification: schema.SessionNotification): void;
  onPermissionRequest(
    request: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse>;
}

export class AcpClient {
  private readonly connection: ClientConnection;
  private capabilities: schema.AgentCapabilities = {};

  constructor(
    private readonly sid: KbblSessionId,
    child: AcpChildProcess,
    handlers: AcpClientHandlers,
  ) {
    this.connection = client({ name: `kbbl:${sid}` })
      .onNotification("session/update", (ctx) => {
        handlers.onSessionUpdate(ctx.params);
      })
      .onRequest("session/request_permission", (ctx) =>
        handlers.onPermissionRequest(ctx.params),
      )
      .connect(ndJsonStream(child.stdin, child.stdout));
  }

  /** Resolves when the transport closes (child exit, stream error). */
  get closed(): Promise<void> {
    return this.connection.closed;
  }

  get agentCapabilities(): schema.AgentCapabilities {
    return this.capabilities;
  }

  close(): void {
    this.connection.close();
  }

  async initialize(): Promise<Result<schema.InitializeResponse, AcpError>> {
    const result = await this.request<schema.InitializeResponse>(
      "acp_initialize_failed",
      "client.initialize",
      () =>
        this.connection.agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
    );
    if (!result.ok) return result;
    if (result.value.protocolVersion !== PROTOCOL_VERSION) {
      return err(
        acpError(
          "acp_protocol_mismatch",
          "client.initialize",
          `agent answered protocol v${result.value.protocolVersion}, kbbl requires v${PROTOCOL_VERSION}`,
          this.sid,
        ),
      );
    }
    this.capabilities = result.value.agentCapabilities ?? {};
    return result;
  }

  newSession(
    cwd: string,
  ): Promise<Result<schema.NewSessionResponse, AcpError>> {
    return this.request(
      "acp_session_new_failed",
      "client.newSession",
      () =>
        this.connection.agent.request("session/new", { cwd, mcpServers: [] }),
    );
  }

  loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<Result<schema.LoadSessionResponse | void, AcpError>> {
    return this.request(
      "acp_session_load_failed",
      "client.loadSession",
      () =>
        this.connection.agent.request("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        }),
    );
  }

  prompt(
    sessionId: string,
    text: string,
  ): Promise<Result<schema.PromptResponse, AcpError>> {
    return this.request("acp_prompt_failed", "client.prompt", () =>
      this.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    );
  }

  async cancel(sessionId: string): Promise<Result<void, AcpError>> {
    try {
      await this.connection.agent.notify("session/cancel", { sessionId });
      return ok(undefined);
    } catch (error) {
      return err(this.toError("acp_cancel_failed", "client.cancel", error));
    }
  }

  closeSession(
    sessionId: string,
  ): Promise<Result<schema.CloseSessionResponse | void, AcpError>> {
    return this.request(
      "acp_close_failed",
      "client.closeSession",
      () => this.connection.agent.request("session/close", { sessionId }),
    );
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<schema.SetSessionConfigOptionResponse, AcpError>> {
    const params =
      typeof value === "boolean"
        ? { sessionId, configId, value, type: "boolean" as const }
        : { sessionId, configId, value };
    return this.request(
      "acp_config_unsupported",
      "client.setConfigOption",
      () =>
        this.connection.agent.request("session/set_config_option", params),
    );
  }

  private async request<T>(
    code: AcpFailureCode,
    operation: string,
    send: () => Promise<T>,
  ): Promise<Result<T, AcpError>> {
    try {
      return ok(await send());
    } catch (error) {
      return err(this.toError(code, operation, error));
    }
  }

  private toError(
    code: AcpFailureCode,
    operation: string,
    error: unknown,
  ): AcpError {
    if (error instanceof RequestError) {
      return acpError(
        code,
        operation,
        `agent error ${error.code}: ${error.message}`,
        this.sid,
      );
    }
    // A rejection that is not a JSON-RPC error means the transport itself
    // failed (child exit, closed stream) — the answer never arrived, so
    // the outcome is uncertain (§10.4), whatever the operation was.
    return acpError("acp_transport_lost", operation, String(error), this.sid);
  }
}
