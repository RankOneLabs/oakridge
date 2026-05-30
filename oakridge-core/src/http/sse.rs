//! SSE streaming endpoints.
//!
//! ## Retention and gap semantics
//!
//! Backfill is served from the [`EventBus`] ring buffer (1 024 events per scope,
//! as set by `RING_CAP` in [`crate::events`]).  When `?since` precedes the oldest
//! retained sequence number, the stream first emits a **named** `gap` SSE event
//! (`data: {"oldest_seq": N}`) before continuing with whatever the buffer holds
//! and the live tail.  Clients that receive a `gap` event should reload current
//! state via the REST endpoints and then resubscribe with `?since=oldest_seq`.
//!
//! Live broadcast receivers that fall behind (`RecvError::Lagged`) also emit a
//! `gap` event carrying the current oldest retained seq and then resume from the
//! next surviving message.
//!
//! Normal data events are unnamed (SSE `message` type) so the PWA can use a
//! single `EventSource.onmessage` handler reading the `kind` field from the JSON
//! payload.  The SSE `id` field carries the event's monotonic `seq` number so
//! browsers auto-resume via `Last-Event-ID`; the `?since` query parameter covers
//! programmatic reconnects.

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use futures::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::events::{BackfillScope, EventBus, SeqEvent};
use crate::types::WorkflowRunId;

use super::rest::AppError;
use super::AppState;

// ── Query param extractor ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SinceQuery {
    pub since: Option<u64>,
}

// ── Internal scope key ────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum ScopeKey {
    Global,
    Run(WorkflowRunId),
}

// ── Stream builder ────────────────────────────────────────────────────────────

/// Build the SSE stream for `scope` starting from events with seq > `since`.
///
/// Construction order guarantees no gap/dup at the backfill→live seam:
/// 1. Subscribe to the broadcast channel (live events start buffering).
/// 2. Read the ring buffer for `seq > since`.
/// 3. Emit the `gap` event if the cursor predates the oldest retained seq.
/// 4. Yield buffered events, advancing `last_emitted_seq`.
/// 5. Forward live events, skipping any whose seq ≤ `last_emitted_seq`.
fn build_sse_stream(
    bus: Arc<EventBus>,
    scope: ScopeKey,
    since: u64,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let (tx, rx) = futures::channel::mpsc::unbounded::<Result<Event, Infallible>>();

    // Step 1 — subscribe FIRST to close the race between buffer-read and live-attach.
    let live_rx = match scope {
        ScopeKey::Global => bus.subscribe_global(),
        ScopeKey::Run(run_id) => bus.subscribe_run(run_id),
    };

    // Step 2 — read the ring buffer for events with seq > since.
    let (backfill_events, gap_flag) = match scope {
        ScopeKey::Global => bus.backfill(BackfillScope::Global, since),
        ScopeKey::Run(run_id) => bus.backfill(BackfillScope::Run(&run_id), since),
    };

    tokio::spawn(async move {
        let mut last_seq = since;

        // Step 3 — gap event when a reconnecting client's cursor predates the oldest
        // retained event (since > 0 guards against the false positive where since = 0
        // always satisfies since < first_seq because EventBus seq starts at 1).
        if gap_flag && since > 0 {
            let oldest = backfill_events.first().map_or(0, |e| e.seq);
            let data = json!({"oldest_seq": oldest}).to_string();
            if tx.unbounded_send(Ok(Event::default().event("gap").data(data))).is_err() {
                return;
            }
        }

        // Step 4 — yield buffered events and advance the dedup cursor.
        for ev in backfill_events {
            last_seq = ev.seq;
            if tx.unbounded_send(Ok(to_sse_frame(&ev))).is_err() {
                return;
            }
        }

        // Step 5 — forward live events, skipping any already covered by backfill.
        let mut live_rx = live_rx;
        loop {
            match live_rx.recv().await {
                Ok(ev) => {
                    if ev.seq <= last_seq {
                        continue;
                    }
                    last_seq = ev.seq;
                    if tx.unbounded_send(Ok(to_sse_frame(&ev))).is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let oldest = oldest_retained_seq(&bus, scope);
                    let data = json!({"oldest_seq": oldest}).to_string();
                    if tx.unbounded_send(Ok(Event::default().event("gap").data(data))).is_err() {
                        return;
                    }
                    // Continue: next recv() picks up from the oldest surviving broadcast message.
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    rx
}

fn to_sse_frame(ev: &SeqEvent) -> Event {
    Event::default()
        .id(ev.seq.to_string())
        .data(serde_json::to_string(&ev.event).unwrap_or_default())
}

fn oldest_retained_seq(bus: &Arc<EventBus>, scope: ScopeKey) -> u64 {
    let (events, _) = match scope {
        ScopeKey::Global => bus.backfill(BackfillScope::Global, 0),
        ScopeKey::Run(run_id) => bus.backfill(BackfillScope::Run(&run_id), 0),
    };
    events.first().map_or(0, |e| e.seq)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn stream_global_events(
    State(state): State<AppState>,
    Query(params): Query<SinceQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let since = params.since.unwrap_or(0);
    Sse::new(build_sse_stream(state.bus, ScopeKey::Global, since))
        .keep_alive(KeepAlive::default())
}

pub async fn stream_run_events(
    State(state): State<AppState>,
    Path(run_id): Path<Uuid>,
    Query(params): Query<SinceQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let run_id = WorkflowRunId(run_id);
    // 404 if the run id is unknown — avoids an indefinitely empty stream for a typo.
    let _ = crate::db::queries::get_workflow_run_by_id(&state.pool, &run_id).await?;

    let since = params.since.unwrap_or(0);
    Ok(Sse::new(build_sse_stream(state.bus, ScopeKey::Run(run_id), since))
        .keep_alive(KeepAlive::default()))
}

// ── Routes ────────────────────────────────────────────────────────────────────

pub fn sse_routes() -> Router<AppState> {
    Router::new()
        .route("/events", get(stream_global_events))
        .route("/workflow_runs/:id/events", get(stream_run_events))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Test-only seq stream that runs the same subscribe-first + backfill + dedup
/// logic as `build_sse_stream` but yields raw seq numbers instead of `Event`
/// objects (whose internals are not directly inspectable via the public API).
/// A value of `0` signals a gap event. The E2E test covers the real SSE framing.
#[cfg(test)]
fn build_seq_stream_for_test(
    bus: Arc<EventBus>,
    scope: ScopeKey,
    since: u64,
) -> impl futures::Stream<Item = u64> {
    let (tx, rx) = futures::channel::mpsc::unbounded::<u64>();

    let live_rx = match scope {
        ScopeKey::Global => bus.subscribe_global(),
        ScopeKey::Run(run_id) => bus.subscribe_run(run_id),
    };

    let (backfill_events, gap_flag) = match scope {
        ScopeKey::Global => bus.backfill(BackfillScope::Global, since),
        ScopeKey::Run(run_id) => bus.backfill(BackfillScope::Run(&run_id), since),
    };

    tokio::spawn(async move {
        let mut last_seq = since;

        if gap_flag && since > 0 {
            if tx.unbounded_send(0).is_err() {
                return;
            }
        }

        for ev in backfill_events {
            last_seq = ev.seq;
            if tx.unbounded_send(ev.seq).is_err() {
                return;
            }
        }

        let mut live_rx = live_rx;
        loop {
            match live_rx.recv().await {
                Ok(ev) => {
                    if ev.seq <= last_seq {
                        continue;
                    }
                    last_seq = ev.seq;
                    if tx.unbounded_send(ev.seq).is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = tx.unbounded_send(0); // gap
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use futures::StreamExt;
    use uuid::Uuid;

    use crate::events::{EventBus, SubstrateEvent};
    use crate::types::{RunStatus, WorkflowRunId};

    fn run_id() -> WorkflowRunId {
        WorkflowRunId(Uuid::new_v4())
    }

    fn running_event(rid: WorkflowRunId) -> SubstrateEvent {
        SubstrateEvent::RunStatusChanged { run_id: rid, status: RunStatus::Running }
    }

    // ── (a) unit test: stream construction yields events in seq order ──────────

    #[tokio::test]
    async fn stream_yields_events_in_seq_order() {
        let bus = EventBus::new();
        let rid = run_id();

        bus.publish(rid, running_event(rid));
        bus.publish(rid, SubstrateEvent::RunStatusChanged { run_id: rid, status: RunStatus::Done });
        bus.publish(rid, running_event(rid));

        let seqs: Vec<u64> = build_seq_stream_for_test(Arc::clone(&bus), ScopeKey::Run(rid), 0)
            .take(3)
            .collect()
            .await;

        assert_eq!(seqs, vec![1, 2, 3]);
    }

    // ── (b) ?since reconnect: no gap, no dup within the retained window ────────

    #[tokio::test]
    async fn since_cursor_no_gap_no_dup() {
        let bus = EventBus::new();
        let rid = run_id();

        // Publish 5 events — seqs 1..=5.
        for _ in 0..5 {
            bus.publish(rid, running_event(rid));
        }

        // since=2 → expect exactly seqs 3, 4, 5 (no dup of 1/2, no missing seq).
        let seqs: Vec<u64> = build_seq_stream_for_test(Arc::clone(&bus), ScopeKey::Run(rid), 2)
            .take(3)
            .collect()
            .await;

        assert_eq!(seqs, vec![3, 4, 5]);
    }

    // ── (c) end-to-end: wire framing over raw TCP ─────────────────────────────

    async fn test_state() -> AppState {
        use crate::db;
        use crate::registry::{ArtifactTypeRegistry, StageTypeRegistry};
        use crate::registry::artifact_type::ArtifactTypeDef;
        use crate::scheduler::Coordinator;

        let path = format!("/tmp/oakridge_sse_{}.db", Uuid::new_v4());
        let pool = Arc::new(db::init_pool(&format!("sqlite:{path}")).await.unwrap());

        let stage_registry = Arc::new(StageTypeRegistry::new());

        let mut art_reg = ArtifactTypeRegistry::new();
        art_reg.register(ArtifactTypeDef {
            id: "any".into(),
            validate: |_| Ok(()),
            component_id: "v".into(),
        });
        let artifact_registry = Arc::new(art_reg);

        let bus = EventBus::new();
        let coordinator = Arc::new(Coordinator::new(
            pool.clone(),
            stage_registry.clone(),
            artifact_registry.clone(),
            bus.clone(),
        ));

        AppState { pool, stage_registry, artifact_registry, coordinator, bus }
    }

    #[tokio::test]
    async fn e2e_global_events_over_tcp() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::TcpListener;

        let state = test_state().await;
        let bus = Arc::clone(&state.bus);

        // Build the full router (includes SSE routes merged in router()).
        let router = crate::http::router(state);

        // Publish 2 events before connecting — they will be served from backfill.
        let rid = run_id();
        bus.publish(rid, running_event(rid));
        bus.publish(rid, SubstrateEvent::RunStatusChanged { run_id: rid, status: RunStatus::Done });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        // Yield so the server task reaches accept() before we connect.
        tokio::task::yield_now().await;

        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (reader_half, mut writer_half) = tcp.into_split();
        let mut reader = BufReader::new(reader_half);

        writer_half
            .write_all(
                b"GET /events?since=0 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();

        // Consume HTTP response headers (stop at the first blank CRLF line).
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            if line == "\r\n" || line.trim().is_empty() {
                break;
            }
        }

        // Read SSE frames.  HTTP/1.1 uses chunked transfer encoding:
        //   <hex_size>\r\n<sse text>\r\n
        // We skip pure-hex lines (chunk-size markers) and parse id:/data: fields,
        // emitting a collected event on each blank line.
        let mut current_id: Option<String> = None;
        let mut current_data: Option<String> = None;
        let mut events: Vec<(String, String)> = vec![];

        let read_fut = async {
            while events.len() < 2 {
                let mut line = String::new();
                let n = reader.read_line(&mut line).await.unwrap();
                if n == 0 {
                    break;
                }
                let trimmed = line.trim_end_matches(|c: char| c == '\r' || c == '\n');

                // Skip HTTP chunked-encoding size lines (pure hex digits).
                if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
                    continue;
                }

                if trimmed.is_empty() {
                    if let (Some(id), Some(data)) = (current_id.take(), current_data.take()) {
                        events.push((id, data));
                    }
                } else if let Some(rest) = trimmed.strip_prefix("id:") {
                    current_id = Some(rest.trim().to_string());
                } else if let Some(rest) = trimmed.strip_prefix("data:") {
                    current_data = Some(rest.trim().to_string());
                }
                // Skip SSE comment lines (keep-alive pings) and event: lines.
            }
        };

        tokio::time::timeout(std::time::Duration::from_secs(5), read_fut)
            .await
            .expect("timed out waiting for SSE events");

        assert_eq!(events.len(), 2, "expected 2 events, got: {events:?}");

        // Seq 1 → RunStatusChanged(Running), seq 2 → Done.
        assert_eq!(events[0].0, "1");
        assert_eq!(events[1].0, "2");

        let v0: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
        let v1: serde_json::Value = serde_json::from_str(&events[1].1).unwrap();
        assert_eq!(v0["kind"], "run_status_changed");
        assert_eq!(v0["status"], "running");
        assert_eq!(v1["status"], "done");
    }
}
