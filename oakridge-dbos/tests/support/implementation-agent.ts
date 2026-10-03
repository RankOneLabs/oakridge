/** Scripted ACP child. kbbl owns the process and delivers the actual rendered prompt. */
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { JsonValue } from "../../src/domain/primitives";

export interface AgentPublication { readonly output_name: string; readonly body: JsonValue }
export type ImplementationAgentPlan =
  | { readonly kind: "publish"; readonly commit_build: boolean; readonly publications: readonly AgentPublication[] }
  | { readonly kind: "exit_without_publication" };
export interface ImplementationAgentLaunch {
  readonly attempt_id: string;
  readonly prompt: string;
  readonly base_url: string;
  readonly capability: string;
}
export interface ImplementationAgentDelivery {
  readonly attempt_id: string;
  readonly output_name: string;
  readonly status: number;
  readonly body: JsonValue;
}

const run = async (): Promise<void> => {
  const control = process.env.OAKRIDGE_B3_AGENT_CONTROL_URL!;
  const options = [{ type: "select" as const, id: "model", name: "Model", category: "model" as const,
    currentValue: "test", options: [{ value: "test", name: "Test" }] }];
  const app = agent({ name: "oakridge-b3-agent" })
    .onRequest("initialize", () => ({ protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }))
    .onRequest("session/new", () => ({ sessionId: crypto.randomUUID(), configOptions: options }))
    .onRequest("session/load", () => ({ configOptions: options }))
    .onRequest("session/set_config_option", () => ({ configOptions: options }))
    .onRequest("session/close", () => ({}))
    .onNotification("session/cancel", () => {})
    .onRequest("session/prompt", async (context) => {
      const prompt = context.params.prompt.map((block) => block.type === "text" ? block.text : "").join("");
      const endpoint = prompt.match(/PUT (https?:\/\/[^\s]+)\/work-orders\/([^/\s]+)\/emit\/<output-name>/);
      const capability = prompt.match(/^Work-Order-Capability: (\S+)$/m)?.[1];
      if (!endpoint || !capability) throw new Error("missing publication authority in the application prompt");
      const launch: ImplementationAgentLaunch = { attempt_id: endpoint[2]!, base_url: endpoint[1]!, capability, prompt };
      await fetch(`${control}/launch`, { method: "POST", body: JSON.stringify(launch) });
      let plan: ImplementationAgentPlan | null = null;
      while (!plan) {
        plan = await fetch(`${control}/plan/${launch.attempt_id}`).then((response) => response.json()) as ImplementationAgentPlan | null;
        if (!plan) await Bun.sleep(25);
      }
      if (plan.kind === "exit_without_publication") {
        setTimeout(() => process.exit(0), 10);
        return { stopReason: "end_turn" as const };
      }
      if (plan.commit_build) {
        const branch = prompt.match(/^Canonical cohort ref: (.+)$/m)?.[1];
        if (!branch) throw new Error("missing canonical branch");
        const commit = Bun.spawn(["git", "-c", "user.name=B3 agent", "-c", "user.email=b3@example.invalid",
          "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", launch.attempt_id], { stdout: "ignore", stderr: "inherit" });
        if (await commit.exited !== 0) throw new Error("scripted build commit failed");
        const head = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
        const sha = (await new Response(head.stdout).text()).trim();
        if (await head.exited !== 0) throw new Error("scripted build head is unavailable");
        // The forge fixture's origin is a local bare repo. No network or external PR is written.
        const update = Bun.spawn(["git", "--git-dir", process.env.OAKRIDGE_B3_ORIGIN_PATH!, "update-ref", `refs/heads/${branch}`, sha],
          { stdout: "ignore", stderr: "inherit" });
        if (await update.exited !== 0) throw new Error("fixture origin update failed");
      }
      for (const publication of plan.publications) {
        const response = await fetch(`${launch.base_url}/work-orders/${launch.attempt_id}/emit/${publication.output_name}`, {
          method: "PUT", headers: { "content-type": "application/json", "work-order-capability": capability },
          body: JSON.stringify(publication.body),
        });
        const delivery: ImplementationAgentDelivery = { attempt_id: launch.attempt_id, output_name: publication.output_name,
          status: response.status, body: await response.json() as JsonValue };
        await fetch(`${control}/delivery`, { method: "POST", body: JSON.stringify(delivery) });
      }
      return { stopReason: "end_turn" as const };
    });
  app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
};

if (process.argv.includes("--b3-agent")) await run();
