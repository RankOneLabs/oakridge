import type { OperatorInboxItem, OperatorInboxPage } from "../operator-contracts";

/** Every inbox page, merged. */
export interface OperatorInbox { readonly items: readonly OperatorInboxItem[] }

export async function readAllInboxPages(fetch_page: (path: string) => Promise<OperatorInboxPage>): Promise<OperatorInbox> {
  const items: OperatorInboxItem[] = [];
  let next_cursor: string | null = null;
  do {
    const page: OperatorInboxPage = await fetch_page(next_cursor === null ? "/api/inbox" : `/api/inbox?cursor=${encodeURIComponent(next_cursor)}`);
    items.push(...page.items);
    next_cursor = page.next_cursor;
  } while (next_cursor !== null);
  return { items };
}
