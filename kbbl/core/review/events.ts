import { EventBus } from "../stream/event-bus";
import { artifactEventBus } from "../stream/artifact-event-bus";
import type { ArtifactEventPayloadByName } from "../stream/artifact-event-bus";

export type ReviewEventMap = ArtifactEventPayloadByName;

export const reviewEvents = new EventBus<ReviewEventMap>();

function nowTs(): string {
  return new Date().toISOString();
}

// Mirror all review events to artifactEventBus so /artifact-stream carries them.
reviewEvents.subscribe("atom_edit.applied", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "atom_edit.applied", p, nowTs());
});

reviewEvents.subscribe("thread.created", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.created", p, nowTs());
});

reviewEvents.subscribe("thread.message_added", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.message_added", p, nowTs());
});

reviewEvents.subscribe("thread.resolved", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.resolved", p, nowTs());
});

reviewEvents.subscribe("artifact.frozen", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "artifact.frozen", p, nowTs());
});

reviewEvents.subscribe("artifact.reopened", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "artifact.reopened", p, nowTs());
});

reviewEvents.subscribe("thread.ping_received", (p) => {
  artifactEventBus.publish(p.target_type, p.target_id, "thread.ping_received", p, nowTs());
});
