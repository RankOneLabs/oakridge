import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { resolveObserve } from "../src/effects/outcomes";
import { createEffectProvider } from "../src/effects/operations/production-provider";
import type { ExternalHandle, InvocationId, StableInvocation } from "../src/effects/provider";
import type { SqlExecutor } from "../src/storage/sql-executor";

const definitions = ["development", "development-independent-siblings"] as const;
const terminal = { session: { endReason: "subprocess_exited" }, exit_code: 0 };

async function withObserver(bundle: DefinitionBundle, reply: () => unknown,
  use: (observe: (scope_key: string, worker_key: string) => Promise<ReturnType<typeof resolveObserve>>) => Promise<void>): Promise<void> {
  const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(reply()) });
  try {
    let selected_scope = "";
    const db = { query: async () => [{ source: bundle, scope_key: selected_scope, scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
    const provider = createEffectProvider({ db, core: started.value, kbbl_base_url: server.url.href });
    await use(async (scope_key, worker_key) => {
      const scope = bundle.scopes.find((item) => item.key === scope_key)!;
      const worker = scope.workers.find((item) => item.key === worker_key)!;
      const action = worker.actions.find((item) => item.operation === "session.run")!;
      selected_scope = scope_key;
      const invocation: StableInvocation = {
        id: `session-${scope_key}-${worker_key}` as InvocationId,
        execution_id: "execution",
        selection: { selection: { worker: worker_key, action: action.key },
          definition: { contract_version: action.contract_version, deadline_ms: action.deadline_ms,
            input_schema: action.input_schema, max_attempts: action.max_attempts,
            operation: action.operation, outputs: action.outputs, settings: action.settings, tools: action.tools },
          input: { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } } },
        request: { version: 1, kind: "kbbl_session", session_key: "session" }, bytes: "{}",
      };
      const handle: ExternalHandle = { kind: "kbbl_session", session_id: "session" };
      return resolveObserve({ invocation, action: "start", handle }, await provider.observe(invocation, handle));
    });
  } finally { server.stop(true); started.value.close(); }
}

for (const definition of definitions) {
  test(`${definition}: all six shipped session workers complete through observe with unit results`, async () => {
    const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, `../../workflow-config/definitions/${definition}.json`)).json();
    const sessions = bundle.scopes.flatMap((scope) => scope.workers
      .filter((worker) => worker.actions.some((action) => action.operation === "session.run"))
      .map((worker) => ({ scope: scope.key, worker: worker.key, schema: worker.result_schema })));
    expect(sessions).toHaveLength(6);
    expect(sessions.map((item) => item.schema)).toEqual(Array(6).fill("unit"));
    await withObserver(bundle, () => terminal, async (observe) => {
      for (const session of sessions) {
        const outcome = await observe(session.scope, session.worker);
        expect(outcome).toMatchObject({ kind: "terminal", result: { schema: "unit", data: { kind: "record", fields: [] } } });
      }
    });
  });
}

