#!/usr/bin/env bun
// Deterministic fake ACP agent for kbbl substrate tests (§24.1): a real
// child process speaking ACP v1 over stdio via the official SDK, so tests
// exercise the same spawn/stream/protocol path as production without a
// paid agent. Scenario selection via env:
//
//   FAKE_ACP_BEHAVIOR=
//     "happy"            → default. Streamed reply (thought, tool call,
//                          message chunks), end_turn. Transcript persisted
//                          for session/load replay.
//     "delayed"          → happy, but waits FAKE_ACP_DELAY_MS (default
//                          500) mid-prompt; cancellable during the wait.
//     "permission"       → sends session/request_permission mid-prompt;
//                          "allow" proceeds to end_turn, anything else
//                          stops with "refusal".
//     "crash_mid_prompt" → emits one chunk then exits 1 with the prompt
//                          request unanswered.
//     "no_load"          → initialize does not advertise loadSession.
//     "malformed"        → writes a non-JSON line to stdout mid-prompt.
//     "stderr_spam"      → happy, plus continuous stderr noise.
//     "close_ignored"    → session/close never answers (kill-path test).
//
//   FAKE_ACP_STATE_DIR=  transcript dir (required for load replay across
//                        process restarts). Defaults to a tmp subdir.
//   FAKE_ACP_DELAY_MS=   delay for "delayed".

import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
} from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const behavior = process.env.FAKE_ACP_BEHAVIOR ?? "happy";
const stateDir =
  process.env.FAKE_ACP_STATE_DIR ?? join(tmpdir(), "fake-acp-state");
const delayMs = Number(process.env.FAKE_ACP_DELAY_MS ?? "500");

mkdirSync(stateDir, { recursive: true });

if (behavior === "stderr_spam") {
  setInterval(() => {
    process.stderr.write(
      `fake-acp noise ${Date.now()} not json { definitely: not protocol\n`,
    );
  }, 5).unref();
}

const cancelled = new Set<string>();

function transcriptPath(sessionId: string): string {
  return join(stateDir, `${sessionId}.jsonl`);
}

function record(sessionId: string, update: schema.SessionUpdate): void {
  appendFileSync(transcriptPath(sessionId), `${JSON.stringify(update)}\n`);
}

async function notifyAndRecord(
  client: AgentContext,
  sessionId: string,
  update: schema.SessionUpdate,
): Promise<void> {
  record(sessionId, update);
  await client.notify("session/update", { sessionId, update });
}

const CONFIG_OPTIONS: schema.SessionConfigOption[] = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "fake-small",
    options: [
      { value: "fake-small", name: "Fake Small" },
      { value: "fake-large", name: "Fake Large" },
    ],
  },
  {
    type: "select",
    id: "effort",
    name: "Reasoning effort",
    category: "thought_level",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

// Current config values per session (in-memory; config state does not
// need to survive the fake's restarts).
const configState = new Map<string, Map<string, string | boolean>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const app = agent({ name: `fake-acp-${behavior}` })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: behavior !== "no_load",
      sessionCapabilities: { close: {} },
    },
  }))
  .onRequest("session/new", (ctx) => {
    const sessionId = `fake-${randomUUID()}`;
    appendFileSync(transcriptPath(sessionId), "");
    configState.set(sessionId, new Map());
    void ctx;
    return { sessionId, configOptions: CONFIG_OPTIONS };
  })
  .onRequest("session/load", async (ctx) => {
    if (behavior === "no_load") {
      throw RequestError.methodNotFound("session/load");
    }
    const { sessionId } = ctx.params;
    const path = transcriptPath(sessionId);
    if (!existsSync(path)) {
      throw RequestError.resourceNotFound(sessionId);
    }
    if (behavior === "delayed_load") await delay(Math.max(0, delayMs));
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const update = JSON.parse(line) as schema.SessionUpdate;
      await ctx.client.notify("session/update", { sessionId, update });
    }
    // The stable session/load contract answers with configOptions just
    // like session/new, so a client can rebuild its selectors after a
    // respawn without waiting for a config_option_update.
    if (!configState.has(sessionId)) configState.set(sessionId, new Map());
    const options = CONFIG_OPTIONS.map((option) => {
      const current = configState.get(sessionId)?.get(option.id);
      return current === undefined
        ? option
        : ({ ...option, currentValue: current } as schema.SessionConfigOption);
    });
    return { configOptions: options };
  })
  .onRequest("session/set_config_option", (ctx) => {
    const { sessionId, configId, value } = ctx.params;
    const known = CONFIG_OPTIONS.some((option) => option.id === configId);
    if (!known) {
      throw RequestError.invalidParams(undefined, `unknown config "${configId}"`);
    }
    configState.get(sessionId)?.set(configId, value as string | boolean);
    const options = CONFIG_OPTIONS.map((option) => {
      const current = configState.get(sessionId)?.get(option.id);
      return current === undefined
        ? option
        : ({ ...option, currentValue: current } as schema.SessionConfigOption);
    });
    return { configOptions: options };
  })
  .onRequest("session/close", async () => {
    if (behavior === "close_ignored") {
      await new Promise(() => {});
    }
    return {};
  })
  .onNotification("session/cancel", (ctx) => {
    cancelled.add(ctx.params.sessionId);
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    cancelled.delete(sessionId);
    const text = prompt
      .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join("");

    await notifyAndRecord(ctx.client, sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });

    if (behavior === "crash_mid_prompt") {
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "about to crash" },
        },
      });
      process.exit(1);
    }

    if (behavior === "malformed") {
      process.stdout.write("this is not a json-rpc line\n");
    }

    await notifyAndRecord(ctx.client, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking about it" },
    });

    if (behavior === "delayed") {
      const waited = Math.max(0, delayMs);
      const step = 20;
      for (let elapsed = 0; elapsed < waited; elapsed += step) {
        if (cancelled.has(sessionId)) {
          return { stopReason: "cancelled" as const };
        }
        await delay(step);
      }
    }

    if (behavior === "permission") {
      const response = await ctx.client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "fake-tool-1", title: "Run fake tool" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = response.outcome;
      if (outcome.outcome !== "selected" || outcome.optionId !== "allow") {
        return { stopReason: "refusal" as const };
      }
    }

    await notifyAndRecord(ctx.client, sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "fake-tool-1",
      title: "Fake tool",
      status: "in_progress",
    });
    await notifyAndRecord(ctx.client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "fake-tool-1",
      status: "completed",
    });
    if (cancelled.has(sessionId)) {
      return { stopReason: "cancelled" as const };
    }
    await notifyAndRecord(ctx.client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `fake reply to: ${text}` },
    });
    return { stopReason: "end_turn" as const };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
