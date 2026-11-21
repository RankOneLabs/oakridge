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
//     "persist_on_prompt" → session/new stays in memory until the first
//                           prompt, like agents with lazy transcript storage.
//     "load_renames_models" → happy, but session/load offers `fake-large`
//                           as `fake-large-2` under the same name, like a
//                           reloaded Claude session offering
//                           `claude-fable-5-2` in place of `fable`.
//     "efforts_follow_model" → happy, but the `max` effort is only offered
//                           once `fake-large` is the selected model, like
//                           agents whose efforts depend on the model.
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

interface ScriptedPromptResponse {
  usage?: schema.Usage;
  _meta?: { [key: string]: unknown };
}
interface UsageScriptEntry {
  response?: ScriptedPromptResponse;
  updates?: schema.UsageUpdate[];
}
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const usageTurnIndices = new Map<string, number>();
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
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Manual" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "auto", name: "Auto" },
    ],
  },
];

// Current config values per session (in-memory; config state does not
// need to survive the fake's restarts).
const configState = new Map<string, Map<string, string | boolean>>();
// Sessions this process answered with session/load.
const loadedSessions = new Set<string>();

/** The config options a session sees now, with its current values. */
function sessionConfigOptions(sessionId: string): schema.SessionConfigOption[] {
  const renamed = behavior === "load_renames_models" && loadedSessions.has(sessionId);
  const offersMax = behavior === "efforts_follow_model" && configState.get(sessionId)?.get("model") === "fake-large";
  return CONFIG_OPTIONS.map((option) => {
    const renamedOption = renamed ? renameReloadedModel(option) : option;
    const offered = offersMax ? offerMaxEffort(renamedOption) : renamedOption;
    const current = configState.get(sessionId)?.get(option.id);
    return current === undefined
      ? offered
      : ({ ...offered, currentValue: current } as schema.SessionConfigOption);
  });
}

/** The effort selector with `max` added. */
function offerMaxEffort(option: schema.SessionConfigOption): schema.SessionConfigOption {
  if (option.type !== "select" || option.id !== "effort") return option;
  return { ...option, options: [...option.options, { value: "max", name: "Max" }] } as schema.SessionConfigOption;
}

/** The model selector a reloaded session sees: `fake-large` under a new id, same name. */
function renameReloadedModel(option: schema.SessionConfigOption): schema.SessionConfigOption {
  if (option.type !== "select" || option.id !== "model") return option;
  const rename = (entry: schema.SessionConfigSelectOption): schema.SessionConfigSelectOption =>
    entry.value === "fake-large" ? { ...entry, value: "fake-large-2" } : entry;
  const options = option.options.map((entry) => ("value" in entry ? rename(entry) : entry));
  return { ...option, options } as schema.SessionConfigOption;
}

// The workspace roots the client granted on session/new or session/load,
// kept beside the transcript so tests can read what reached the agent.
function recordAdditionalDirectories(
  sessionId: string,
  additionalDirectories: readonly string[] | undefined,
): void {
  writeFileSync(
    join(stateDir, `${sessionId}.additional-directories.json`),
    JSON.stringify(additionalDirectories ?? []),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const app = agent({ name: `fake-acp-${behavior}` })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: behavior !== "no_load",
      sessionCapabilities: { close: {}, additionalDirectories: {} },
    },
  }))
  .onRequest("session/new", (ctx) => {
    if (behavior === "new_session_error") {
      throw new Error("Claude Code process exited with code 1");
    }
    const sessionId = `fake-${randomUUID()}`;
    if (behavior !== "persist_on_prompt") appendFileSync(transcriptPath(sessionId), "");
    configState.set(sessionId, new Map());
    recordAdditionalDirectories(sessionId, ctx.params.additionalDirectories);
    writeFileSync(join(stateDir, `${sessionId}.auth-marker.json`), JSON.stringify(process.env.KBBL_TEST_AUTH_MARKER ?? null));
    writeFileSync(join(stateDir, `${sessionId}.mcp-servers.json`), JSON.stringify(ctx.params.mcpServers));
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
    recordAdditionalDirectories(sessionId, ctx.params.additionalDirectories);
    writeFileSync(join(stateDir, `${sessionId}.load-mcp-servers.json`), JSON.stringify(ctx.params.mcpServers));
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
    loadedSessions.add(sessionId);
    return { configOptions: sessionConfigOptions(sessionId) };
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const { sessionId, configId, value } = ctx.params;
    const known = CONFIG_OPTIONS.some((option) => option.id === configId);
    if (!known) {
      throw RequestError.invalidParams(undefined, `unknown config "${configId}"`);
    }
    // Tests can trigger a live notification after a prompt has completed,
    // without timers or injecting events directly into the controller.
    const usageOnConfig = Bun.file(join(stateDir, "usage-on-config.json"));
    if (await usageOnConfig.exists()) {
      const updates: schema.UsageUpdate[] = await usageOnConfig.json();
      for (const update of updates) {
        await notifyAndRecord(ctx.client, sessionId, { sessionUpdate: "usage_update", ...update });
      }
    }
    configState.get(sessionId)?.set(configId, value as string | boolean);
    return { configOptions: sessionConfigOptions(sessionId) };
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
    // Optional per-turn script: raw response extensions and usage notifications.
    const scriptFile = Bun.file(join(stateDir, "usage-script.json"));
    if (await scriptFile.exists()) {
      const scripts: UsageScriptEntry[] = await scriptFile.json();
      const index = usageTurnIndices.get(sessionId) ?? 0;
      usageTurnIndices.set(sessionId, index + 1);
      const scripted = scripts[index];
      for (const update of scripted?.updates ?? []) {
        await notifyAndRecord(ctx.client, sessionId, { sessionUpdate: "usage_update", ...update });
      }
      return { stopReason: "end_turn" as const, ...scripted?.response };
    }
    return { stopReason: "end_turn" as const };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
