export interface DbosTransportClient {
  send(destination_id: string, message: unknown, topic?: string, idempotency_key?: string): Promise<void>;
}

export let transportClient: DbosTransportClient | null = null;
export const registerDbosTransportClient = (client: DbosTransportClient): void => { transportClient = client; };
