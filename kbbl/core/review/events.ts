import { EventBus } from "../stream/event-bus";
import { artifactEventBus } from "../stream/artifact-event-bus";

export interface ReviewEventMap {
  "atom_edit.applied": {
    id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    new_value: string;
    author: string;
  };
  "thread.created": {
    id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    author: string | null;
  };
  "thread.message_added": {
    id: string;
    thread_id: string;
    target_type: string;
    target_id: string;
    author: string;
    body: string;
  };
  "thread.resolved": {
    id: string;
    target_type: string;
    target_id: string;
  };
  "artifact.frozen": {
    target_type: string;
    target_id: string;
  };
  "artifact.reopened": {
    target_type: string;
    target_id: string;
  };
  "thread.ping_received": {
    thread_id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    responder_id?: string;
  };
}

export const reviewEvents = new EventBus<ReviewEventMap>();

function nowTs(): string {
  return new Date().toISOString();
}

// Mirror all review events to artifactEventBus so /safir-stream carries them.
reviewEvents.subscribe("atom_edit.applied", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "atom_edit.applied", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("thread.created", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.created", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("thread.message_added", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.message_added", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("thread.resolved", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.resolved", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("artifact.frozen", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "artifact.frozen", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("artifact.reopened", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "artifact.reopened", p as Record<string, unknown>, nowTs());
});

reviewEvents.subscribe("thread.ping_received", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.ping_received", p as Record<string, unknown>, nowTs());
});
