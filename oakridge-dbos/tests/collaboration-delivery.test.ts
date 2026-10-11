import { expect, test } from "bun:test";
import { deliverCollaborationPing, kbblDeliveryPort } from "../src/http/collaboration";
import type { CollaborationDeliveryRecord } from "../src/storage/collaboration";
import type { SqlExecutor } from "../src/storage/sql-executor";

const command = { run_id: "run", scope_id: "scope", thread_id: "thread", revision_id: "edit",
  message_id: "message", request_key: "request-1", text: "Please review the change" };
const request = { session_key: "pinned-key", body: JSON.stringify({ initial_prompt: "start", workdir: "/tmp" }) };
const pinned = { request, session_id: "pinned-session" };

function deliveryDatabase(): { db: SqlExecutor; deliveries: CollaborationDeliveryRecord[] } {
  const deliveries: CollaborationDeliveryRecord[] = [];
  const db: SqlExecutor = { async query<Row extends object>(sql: string, args: readonly unknown[]): Promise<readonly Row[]> {
    if (sql.includes("WITH RECURSIVE predecessors")) return [
      { id: "edit", predecessor_id: "agent", execution_id: null },
      { id: "agent", predecessor_id: null, execution_id: "execution" },
    ] as unknown as Row[];
    if (sql.includes("INSERT INTO authority.collaboration_delivery")) {
      const stored = { id: args[0], run_id: args[1], scope_id: args[2], message_id: args[3],
        payload: JSON.parse(args[4] as string), created_at: new Date().toISOString() } as CollaborationDeliveryRecord;
      deliveries.push(stored);
      return [stored] as unknown as Row[];
    }
    if (sql.includes("FROM authority.collaboration_delivery WHERE id"))
      return deliveries.filter((delivery) => delivery.id === args[0]) as unknown as Row[];
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  return { db, deliveries };
}

async function withKbbl(initial_status: "live" | "ended" | "failed", run: (url: string,
  observations: { readonly ensures: string[]; readonly inputs: string[]; readonly input_attempts: string[] }) => Promise<void>,
  behavior: "preserve" | "replace" | "transient" | "send_transient" | "send_refused" = "preserve"): Promise<void> {
  let status = initial_status;
  let ensure_count = 0;
  const observations = { ensures: [] as string[], inputs: [] as string[], input_attempts: [] as string[] };
  const accepted_inputs = new Map<string,string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/sessions/resumable/pinned-key") {
      observations.ensures.push(status);
      ensure_count += 1;
      if (behavior === "transient" && ensure_count === 1) return Response.json({ error: "temporarily unavailable" }, { status: 503 });
      if (status === "failed") return Response.json({ error: "worktree unavailable" }, { status: 422 });
      if (status === "ended" && request.headers.get("x-oakridge-collaboration-resume") === "true") status = "live";
      return Response.json({ kind: "attached", session: { sid: behavior === "replace" && status === "live" ? "fresh-session" : "pinned-session", status } });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/sessions/resumable/pinned-session/input/")) {
      const key = url.pathname.split("/").at(-1) ?? "";
      const input = (await request.json() as { text: string }).text;
      observations.input_attempts.push(key);
      if (behavior === "send_refused") return Response.json({ error: "session refused input" }, { status: 409 });
      const previous = accepted_inputs.get(key);
      if (previous !== undefined && previous !== input) return Response.json({ error: "delivery_key_conflict" }, { status: 409 });
      if (previous === undefined) {
        accepted_inputs.set(key,input);
        observations.inputs.push(input);
      }
      if (behavior === "send_transient" && observations.input_attempts.length === 1)
        return Response.json({ error: "response lost" }, { status: 503 });
      return Response.json({ accepted: true });
    }
    return Response.json({ error: "session_not_found" }, { status: 404 });
  } });
  try { await run(server.url.href,observations); } finally { server.stop(true); }
}

test("live session accepts one keyed ping and repeat returns the recorded delivery", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("live", async (url, observations) => {
    const port = kbblDeliveryPort(url);
    const first = await deliverCollaborationPing(db,port,command,async () => pinned);
    const repeat = await deliverCollaborationPing(db,port,command,async () => pinned);
    expect(first).toEqual(repeat);
    expect(observations.inputs).toEqual([command.text]);
    expect(deliveries).toHaveLength(1);
  });
});

test("ended producing session is re-ensured before ping delivery", async () => {
  const { db } = deliveryDatabase();
  await withKbbl("ended", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => pinned);
    expect(observations.ensures).toEqual(["ended"]);
    expect(observations.inputs).toEqual([command.text]);
    expect(delivery.payload).toMatchObject({ status: "delivered", session_id: "pinned-session" });
  });
});

test("a replaced sid after collaboration resume cannot receive the pinned ping", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("ended", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => pinned);
    expect(delivery.payload.reason).toContain("instead of pinned session pinned-session");
    expect(observations.inputs).toEqual([]);
    expect(deliveries).toHaveLength(1);
  }, "replace");
});

test("transient ensure result can retry the same request key", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("live", async (url, observations) => {
    const port = kbblDeliveryPort(url);
    await expect(deliverCollaborationPing(db,port,command,async () => pinned)).rejects.toThrow("session ensure uncertain");
    expect(deliveries).toHaveLength(0);
    const delivery = await deliverCollaborationPing(db,port,command,async () => pinned);
    expect(delivery.payload.status).toBe("delivered");
    expect(observations.inputs).toEqual([command.text]);
  }, "transient");
});

test("ensure failure records an explicit reason", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("failed", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => pinned);
    expect(observations.inputs).toEqual([]);
    expect(delivery.payload.reason).toContain("worktree unavailable");
    expect(deliveries).toHaveLength(1);
  });
});

test("permanent input refusal records a failed delivery with a reason", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("live", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => pinned);
    expect(delivery.payload).toMatchObject({ status: "failed", reason: expect.stringContaining("session refused input") });
    expect(observations.inputs).toEqual([]);
    expect(deliveries).toHaveLength(1);
  }, "send_refused");
});

test("uncertain input retries the same delivery key without a second turn", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("live", async (url, observations) => {
    const port = kbblDeliveryPort(url);
    await expect(deliverCollaborationPing(db,port,command,async () => pinned)).rejects.toThrow("session input uncertain");
    expect(deliveries).toHaveLength(0);
    const delivery = await deliverCollaborationPing(db,port,command,async () => pinned);
    expect(delivery.payload.status).toBe("delivered");
    expect(observations.input_attempts).toHaveLength(2);
    expect(observations.inputs).toEqual([command.text]);
    expect(deliveries).toHaveLength(1);
  }, "send_transient");
});
