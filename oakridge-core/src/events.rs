use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::types::{ArtifactId, ArtifactTypeId, RunStatus, StageInstanceId, StageStatus, WorkflowRunId};

const RING_CAP: usize = 1024;
pub(crate) const BROADCAST_CAP: usize = 256;

// ── Wire payload ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubstrateEvent {
    RunStatusChanged {
        run_id: WorkflowRunId,
        status: RunStatus,
    },
    StageStatusChanged {
        stage_instance_id: StageInstanceId,
        status: StageStatus,
        parked_reason: Option<String>,
    },
    ArtifactEmitted {
        artifact_id: ArtifactId,
        artifact_type: ArtifactTypeId,
        producer_stage_id: StageInstanceId,
        parent_artifact_id: Option<ArtifactId>,
    },
    StageResumed {
        stage_instance_id: StageInstanceId,
        resume_kind: String,
    },
}

// ── Sequenced envelope ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SeqEvent {
    pub seq: u64,
    pub event: SubstrateEvent,
}

// ── Backfill scope ────────────────────────────────────────────────────────────

pub enum BackfillScope<'a> {
    Global,
    Run(&'a WorkflowRunId),
}

// ── EventBus ──────────────────────────────────────────────────────────────────

// All mutable state lives behind one lock so seq assignment, broadcast send,
// and ring-buffer append are serialized together — preventing out-of-order
// delivery to broadcast consumers.
struct Inner {
    // Starts at 1 so that `backfill(since=0)` returns all retained events.
    seq: u64,
    global_tx: broadcast::Sender<SeqEvent>,
    global_ring: VecDeque<SeqEvent>,
    per_run_tx: HashMap<WorkflowRunId, broadcast::Sender<SeqEvent>>,
    per_run_ring: HashMap<WorkflowRunId, VecDeque<SeqEvent>>,
}

pub struct EventBus {
    inner: Mutex<Inner>,
}

impl EventBus {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn publish(&self, run_id: WorkflowRunId, event: SubstrateEvent) {
        let mut g = self.inner.lock().unwrap();
        let seq = g.seq;
        g.seq += 1;
        let se = SeqEvent { seq, event };

        let _ = g.global_tx.send(se.clone());

        if g.global_ring.len() >= RING_CAP {
            g.global_ring.pop_front();
        }
        g.global_ring.push_back(se.clone());

        let tx = g.per_run_tx
            .entry(run_id)
            .or_insert_with(|| broadcast::channel(BROADCAST_CAP).0);
        let _ = tx.send(se.clone());

        let ring = g.per_run_ring.entry(run_id).or_insert_with(VecDeque::new);
        if ring.len() >= RING_CAP {
            ring.pop_front();
        }
        ring.push_back(se);
    }

    pub fn subscribe_run(&self, run_id: WorkflowRunId) -> broadcast::Receiver<SeqEvent> {
        let mut g = self.inner.lock().unwrap();
        let tx = g.per_run_tx
            .entry(run_id)
            .or_insert_with(|| broadcast::channel(BROADCAST_CAP).0);
        tx.subscribe()
    }

    pub fn subscribe_global(&self) -> broadcast::Receiver<SeqEvent> {
        self.inner.lock().unwrap().global_tx.subscribe()
    }

    /// Returns (events_with_seq_gt_since, gap_flag).
    /// gap_flag is true when `since` precedes the oldest retained seq.
    pub fn backfill(&self, scope: BackfillScope<'_>, since: u64) -> (Vec<SeqEvent>, bool) {
        let g = self.inner.lock().unwrap();
        match scope {
            BackfillScope::Global => Self::drain_ring(&g.global_ring, since),
            BackfillScope::Run(run_id) => {
                match g.per_run_ring.get(run_id) {
                    None => (vec![], false),
                    Some(ring) => Self::drain_ring(ring, since),
                }
            }
        }
    }

    /// Returns the oldest retained sequence number for `scope`, or 0 if the ring is empty.
    /// Cheaper than `backfill(scope, 0)` when the caller only needs the oldest seq.
    pub fn oldest_seq(&self, scope: BackfillScope<'_>) -> u64 {
        let g = self.inner.lock().unwrap();
        match scope {
            BackfillScope::Global => g.global_ring.front().map_or(0, |e| e.seq),
            BackfillScope::Run(run_id) => g
                .per_run_ring
                .get(run_id)
                .and_then(|ring| ring.front())
                .map_or(0, |e| e.seq),
        }
    }

    /// Remove per-run state after a run reaches a terminal state.
    /// Callers that previously subscribed via `subscribe_run` will receive
    /// `RecvError::Closed` on their next recv, which is the expected signal.
    pub fn cleanup_run(&self, run_id: WorkflowRunId) {
        let mut g = self.inner.lock().unwrap();
        g.per_run_tx.remove(&run_id);
        g.per_run_ring.remove(&run_id);
    }

    fn drain_ring(ring: &VecDeque<SeqEvent>, since: u64) -> (Vec<SeqEvent>, bool) {
        if ring.is_empty() {
            return (vec![], false);
        }
        let oldest_seq = ring.front().unwrap().seq;
        let gap = since < oldest_seq;
        let events: Vec<SeqEvent> = ring.iter().filter(|e| e.seq > since).cloned().collect();
        (events, gap)
    }
}

impl Default for EventBus {
    fn default() -> Self {
        let (global_tx, _) = broadcast::channel(BROADCAST_CAP);
        Self {
            inner: Mutex::new(Inner {
                seq: 1,
                global_tx,
                global_ring: VecDeque::new(),
                per_run_tx: HashMap::new(),
                per_run_ring: HashMap::new(),
            }),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RunStatus;
    use uuid::Uuid;

    fn run_id() -> WorkflowRunId {
        WorkflowRunId(Uuid::new_v4())
    }

    #[test]
    fn publish_assigns_monotonic_seqs() {
        let bus = EventBus::new();
        let r = run_id();
        bus.publish(r, SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Running });
        bus.publish(r, SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Done });
        // seqs 1 and 2 — since=u64::MAX returns nothing, since=0 returns both
        let (events, _) = bus.backfill(BackfillScope::Global, u64::MAX);
        assert!(events.is_empty());
        let (events, _) = bus.backfill(BackfillScope::Global, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
    }

    #[test]
    fn backfill_returns_events_since() {
        let bus = EventBus::new();
        let r = run_id();
        for _ in 0..5 {
            bus.publish(r, SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Running });
        }
        // seqs 1..=5; since=2 returns seqs 3, 4, 5
        let (events, gap) = bus.backfill(BackfillScope::Global, 2);
        assert!(!gap);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].seq, 3);
        assert_eq!(events[1].seq, 4);
        assert_eq!(events[2].seq, 5);
    }

    #[test]
    fn gap_flag_when_buffer_overflows() {
        let bus = EventBus::new();
        let r = run_id();
        for _ in 0..RING_CAP + 10 {
            bus.publish(r, SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Running });
        }
        let (_, gap) = bus.backfill(BackfillScope::Global, 0);
        assert!(gap, "gap flag must be set when since < oldest retained seq");
    }

    #[tokio::test]
    async fn subscribe_run_receives_published() {
        let bus = EventBus::new();
        let r = run_id();
        let mut rx = bus.subscribe_run(r);
        bus.publish(r, SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Done });
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev.event, SubstrateEvent::RunStatusChanged { status: RunStatus::Done, .. }));
    }

    #[tokio::test]
    async fn subscribe_global_receives_all_runs() {
        let bus = EventBus::new();
        let r1 = run_id();
        let r2 = run_id();
        let mut rx = bus.subscribe_global();
        bus.publish(r1, SubstrateEvent::RunStatusChanged { run_id: r1, status: RunStatus::Running });
        bus.publish(r2, SubstrateEvent::RunStatusChanged { run_id: r2, status: RunStatus::Done });
        let e1 = rx.recv().await.unwrap();
        let e2 = rx.recv().await.unwrap();
        assert_eq!(e1.seq, 1);
        assert_eq!(e2.seq, 2);
    }

    #[test]
    fn substrate_event_kind_tag() {
        let r = run_id();
        let ev = SubstrateEvent::RunStatusChanged { run_id: r, status: RunStatus::Done };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["kind"], "run_status_changed");
    }
}
