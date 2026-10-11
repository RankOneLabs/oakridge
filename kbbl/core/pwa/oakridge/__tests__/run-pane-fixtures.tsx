import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/** Browser harness only; all domain read-model fixtures live in __fixtures__/read-models.ts. */
export class EventSourceStub {
  static readonly CLOSED = 2;
  static instances: EventSourceStub[] = [];
  readonly url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; EventSourceStub.instances.push(this); }
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = EventSourceStub.CLOSED; }
}

export function renderWithQuery(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>);
}
