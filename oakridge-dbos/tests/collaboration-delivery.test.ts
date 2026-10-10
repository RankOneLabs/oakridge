import { expect, test } from "bun:test";
import { deliverCollaborationPing, kbblDeliveryPort } from "../src/http/collaboration";
import type { CollaborationDeliveryRecord } from "../src/storage/collaboration";
import type { SqlExecutor } from "../src/storage/sql-executor";

const command = { run_id: "run", scope_id: "scope", thread_id: "thread", revision_id: "edit",
  message_id: "message", request_key: "request-1", text: "Please review the change" };
const request = { session_key: "pinned-key", body: JSON.stringify({ initial_prompt: "start", workdir: "/tmp" }) };

function deliveryDatabase(): { db: SqlExecutor; deliveries: CollaborationDeliveryRecord[] } {
  const deliveries: CollaborationDeliveryRecord[] = [];
  const db: SqlExecutor = { async query<Row extends object>(sql: string, args: readonly unknown[]): Promise<readonly Row[]> {
    if (sql.includes("WITH RECURSIVE predecessors")) return [
      { id: "edit", predecessor_id: "agent", execution_id: null },
      { id: "agent", predecessor_id: null, execution_id: "execution" },
    ] as unknown as Row[];
    if (sql.includes("INSERT INTO authority.collaboration_delivery")) {
      const stored = { id: args[0], run_id: args[1], scope_id: args[2], message_id: args[3],
        payload: JSON.parse(args[4] as string), created_at: new Date() } as CollaborationDeliveryRecord;
      deliveries.push(stored);
      return [stored] as unknown as Row[];
    }
    if (sql.includes("SELECT * FROM authority.collaboration_delivery"))
      return deliveries.filter((delivery) => delivery.id === args[0]) as unknown as Row[];
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  return { db, deliveries };
}

async function withKbbl(initial_status: "live" | "ended" | "failed", run: (url: string,
  observations: { readonly ensures: string[]; readonly inputs: string[] }) => Promise<void>): Promise<void> {
  let status = initial_status;
  const observations = { ensures: [] as string[], inputs: [] as string[] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/sessions/resumable/pinned-key") {
      observations.ensures.push(status);
      if (status === "failed") return Response.json({ error: "worktree unavailable" }, { status: 422 });
      if (status === "ended" && request.headers.get("x-oakridge-collaboration-resume") === "true") status = "live";
      return Response.json({ kind: "attached", session: { sid: status === "live" ? "live-session" : "ended-session", status } });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/sessions/resumable/live-session/input/")) {
      observations.inputs.push((await request.json() as { text: string }).text);
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
    const first = await deliverCollaborationPing(db,port,command,async () => request);
    const repeat = await deliverCollaborationPing(db,port,command,async () => request);
    expect(first).toEqual(repeat);
    expect(observations.inputs).toEqual([command.text]);
    expect(deliveries).toHaveLength(1);
  });
});

test("ended producing session is re-ensured before ping delivery", async () => {
  const { db } = deliveryDatabase();
  await withKbbl("ended", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => request);
    expect(observations.ensures).toEqual(["ended"]);
    expect(observations.inputs).toEqual([command.text]);
    expect(delivery.payload).toMatchObject({ status: "delivered", session_id: "live-session" });
  });
});

test("ensure failure records an explicit reason", async () => {
  const { db, deliveries } = deliveryDatabase();
  await withKbbl("failed", async (url, observations) => {
    const delivery = await deliverCollaborationPing(db,kbblDeliveryPort(url),command,async () => request);
    expect(observations.inputs).toEqual([]);
    expect(delivery.payload.reason).toContain("worktree unavailable");
    expect(deliveries).toHaveLength(1);
  });
});
