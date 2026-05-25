import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EventRow } from "./EventRow";
import type { EnvelopeEvent } from "../../types";

function ev(id: number, type: string, payload: unknown): EnvelopeEvent {
  return { id, type, ts: "2026-05-25T00:00:00.000Z", payload };
}

const defaultProps = {
  resolutions: new Map() as Map<string, "allow" | "deny">,
  allowedTools: new Set<string>(),
  sid: "test-sid",
  sessionStatus: null as null,
  showSystemEvents: true,
  isLatest: false,
};

describe("EventRow — streaming delta events are hidden", () => {
  it("returns null for stream_event (CC streaming delta)", () => {
    const { container } = render(
      <EventRow
        {...defaultProps}
        event={ev(1, "stream_event", { event: { type: "content_block_delta" } })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null for assistant_delta (Codex streaming delta)", () => {
    const { container } = render(
      <EventRow
        {...defaultProps}
        event={ev(1, "assistant_delta", {
          type: "assistant_delta",
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "hello",
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("EventRow — runtime events render as system notices", () => {
  it("renders runtime_session_observed as a system notice", () => {
    render(
      <EventRow
        {...defaultProps}
        event={ev(1, "runtime_session_observed", {
          runtime_id: "codex",
          runtime_sid: "abcdef1234567890",
        })}
      />,
    );
    expect(screen.getByText(/runtime codex session abcdef12…/)).toBeTruthy();
  });

  it("renders runtime_error as a system notice", () => {
    render(
      <EventRow
        {...defaultProps}
        event={ev(1, "runtime_error", { message: "connection refused" })}
      />,
    );
    expect(screen.getByText(/runtime error: connection refused/)).toBeTruthy();
  });

  it("renders runtime_disconnected as a system notice", () => {
    render(
      <EventRow
        {...defaultProps}
        event={ev(1, "runtime_disconnected", {})}
      />,
    );
    expect(screen.getByText("runtime disconnected")).toBeTruthy();
  });

  it("renders runtime_session_observed with unknown runtime gracefully", () => {
    render(
      <EventRow
        {...defaultProps}
        event={ev(1, "runtime_session_observed", {})}
      />,
    );
    expect(screen.getByText(/runtime \? session …/)).toBeTruthy();
  });
});
