import type { OperatorInbox, OperatorInboxPage } from "../operator-contracts";

export async function readAllInboxPages(fetch_page: (path: string) => Promise<OperatorInboxPage>): Promise<OperatorInbox> {
  const cursor: OperatorInbox["cursor"][number][] = [];
  const items: OperatorInbox["items"][number][] = [];
  let next_cursor: string | null = null;
  do {
    const page: OperatorInboxPage = await fetch_page(next_cursor === null ? "/api/inbox" : `/api/inbox?cursor=${encodeURIComponent(next_cursor)}`);
    cursor.push(...page.cursor);
    items.push(...page.items);
    next_cursor = page.next_cursor ?? null;
  } while (next_cursor !== null);
  return { cursor, items };
}
