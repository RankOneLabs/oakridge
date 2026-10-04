/** A separate backend process so durability tests exercise actual crash recovery. */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { resolve } from "node:path";
import { KbblExecutorAdapter } from "../../src/adapters/kbbl";
import { createOakridgeRuntime } from "../../src/runtime/compose";
import { GithubPullRequestReader } from "../../src/runtime/github-pull-requests";
export interface ImplementationRuntimeConfig {
  readonly database_url: string;
  readonly kbbl_url: string;
  readonly forge_url: string;
  readonly executor_identity: string;
  readonly port: number;
}
const config = await Bun.file(process.argv[2]!).json() as ImplementationRuntimeConfig;
DBOS.setConfig({ name: "oakridge-b4-shadow", systemDatabaseUrl: config.database_url, applicationVersion: "b4-shadow", logLevel: "warn" });
const runtime = await createOakridgeRuntime({
  database_url: config.database_url, application_version: "b4-shadow",
  executor_adapters: [new KbblExecutorAdapter({ base_url: config.kbbl_url, executor_function_identity: config.executor_identity, observe_wait_ms: 100 })],
  pull_request_reader: new GithubPullRequestReader({ token: "fixture", api_base_url: config.forge_url }),
  prompt_template_directory: resolve(import.meta.dir, "../../../workflow-config/prompts"),
  pull_request_poll_interval_ms: 1_000,
});
runtime.app.post("/__test/poll", async (http) => { await runtime.poll_pull_requests(); return http.json({}); });
await DBOS.launch();
await runtime.dispatch_launches();
Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: runtime.app.fetch });
