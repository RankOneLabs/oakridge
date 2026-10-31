import type { OperatorDefinitionPage, OperatorDefinitionSummary, OperatorRunInboxBatch, OperatorRunPage, OperatorRunView } from "../operator-contracts";
import { unwrap } from "./core";
import { parseRunInboxBatch, parseRunView } from "./parse";
import { oakridgeGet } from "./http";

const OPERATOR = "/api";

export async function readRunPage(isArchived = false): Promise<OperatorRunView[]> {
  const items: OperatorRunView[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100", archived: String(isArchived) });
    if (cursor) query.set("cursor", cursor);
    const path = `${OPERATOR}/runs?${query}`;
    const page: OperatorRunPage = await oakridgeGet(path);
    if (!Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === "string"))
      throw new Error(`oakridge ${path}: invalid run page`);
    items.push(...page.items.map((run) => unwrap(path, parseRunView(run))));
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

export async function readDefinitions(isArchived: boolean): Promise<OperatorDefinitionSummary[]> {
  const items: OperatorDefinitionSummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ archived: String(isArchived), limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await oakridgeGet<OperatorDefinitionPage>(`${OPERATOR}/definitions?${query}`);
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

export async function readRunInboxBatch(runIds: readonly string[]): Promise<OperatorRunInboxBatch["items"]> {
  const entries: OperatorRunInboxBatch["items"][number][] = [];
  for (let offset = 0; offset < runIds.length; offset += 100) {
    const ids = runIds.slice(offset, offset + 100);
    const path = `${OPERATOR}/run-inboxes?ids=${ids.map(encodeURIComponent).join(",")}`;
    const batch = unwrap(path, parseRunInboxBatch(await oakridgeGet<unknown>(path)));
    entries.push(...batch.items);
  }
  return entries;
}
