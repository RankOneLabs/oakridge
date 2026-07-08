use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

use super::config::{DelegatedRuntime, WorktreeIdentity};

#[derive(Debug, thiserror::Error)]
pub enum KbblClientError {
    #[error("invalid kbbl base url: {0}")]
    InvalidBaseUrl(String),
    #[error("kbbl request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("{method} {path} rejected with {status}: {detail:?}")]
    Rejected {
        method: reqwest::Method,
        path: String,
        status: reqwest::StatusCode,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct KbblClient {
    base_url: reqwest::Url,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSessionRequest {
    pub workdir: String,
    pub name: String,
    pub artifact_id: String,
    pub runtime: DelegatedRuntime,
    /// Omitted entirely when None so kbbl treats the field as absent (not null).
    /// kbbl distinguishes `null` (present invalid value → 400) from omitted (use runtime default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Effort level forwarded to kbbl. Omitted when None so the runtime default applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Managed worktree identity. When present kbbl creates a branch-isolated
    /// worktree; when omitted kbbl uses sid-based naming against HEAD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeIdentity>,
}

/// Typed external reference persisted in stage.external_ref. Wraps the kbbl
/// sid alongside the worktree metadata returned by create-session so the
/// operator can see branch/path even when kbbl is unavailable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DelegatedExternalRef {
    pub sid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_base_ref: Option<String>,
}

impl DelegatedExternalRef {
    /// Parse an external_ref string: try JSON first (typed), fall back to a
    /// plain sid string for backwards compat with pre-typed records.
    pub fn parse(s: &str) -> Self {
        if let Ok(typed) = serde_json::from_str::<Self>(s) {
            return typed;
        }
        Self {
            sid: s.to_owned(),
            worktree_path: None,
            worktree_branch: None,
            worktree_base_ref: None,
        }
    }
}

/// kbbl POST /sessions response. Uses camelCase to match the TypeScript snapshot shape.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub sid: String,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub worktree_base_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AckResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendInputRequest {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetYoloRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolveApprovalRequest {
    pub request_id: String,
    pub decision: ApprovalDecision,
    pub scope: ApprovalScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalScope {
    Once,
    Always,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StopSessionResponse {
    pub ok: bool,
    #[serde(default)]
    pub removed: Option<bool>,
    #[serde(default)]
    pub code: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SessionEvent {
    pub id: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub ts: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct EventsSinceResponse {
    pub session_id: String,
    pub events: Vec<SessionEvent>,
}

impl KbblClient {
    pub fn new(base_url: impl AsRef<str>) -> Result<Self, KbblClientError> {
        let mut base_url = reqwest::Url::parse(base_url.as_ref())
            .map_err(|err| KbblClientError::InvalidBaseUrl(err.to_string()))?;
        if !base_url.path().ends_with('/') {
            let mut path = base_url.path().to_owned();
            path.push('/');
            base_url.set_path(&path);
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(KbblClientError::Request)?;
        Ok(Self { base_url, http })
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<SessionSnapshot, KbblClientError> {
        self.request_json(reqwest::Method::POST, "sessions", &request)
            .await
    }

    pub async fn send_input(
        &self,
        sid: &str,
        request: SendInputRequest,
    ) -> Result<AckResponse, KbblClientError> {
        let sid = path_segment_encode(sid);
        self.request_json(reqwest::Method::POST, &format!("{sid}/input"), &request)
            .await
    }

    pub async fn set_yolo(
        &self,
        sid: &str,
        request: SetYoloRequest,
    ) -> Result<AckResponse, KbblClientError> {
        let sid = path_segment_encode(sid);
        self.request_json(reqwest::Method::POST, &format!("{sid}/yolo"), &request)
            .await
    }

    pub async fn resolve_approval(
        &self,
        sid: &str,
        request: ResolveApprovalRequest,
    ) -> Result<AckResponse, KbblClientError> {
        let sid = path_segment_encode(sid);
        self.request_json(reqwest::Method::POST, &format!("{sid}/approval"), &request)
            .await
    }

    pub async fn stop_session(&self, sid: &str) -> Result<StopSessionResponse, KbblClientError> {
        let sid = path_segment_encode(sid);
        self.delete_json(&format!("sessions/{sid}")).await
    }

    pub async fn read_events_since(
        &self,
        sid: &str,
        since: i64,
    ) -> Result<EventsSinceResponse, KbblClientError> {
        let sid = path_segment_encode(sid);
        self.get_json(&format!("{sid}/events?since={since}")).await
    }

    async fn request_json<TResp, TReq>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &TReq,
    ) -> Result<TResp, KbblClientError>
    where
        TResp: DeserializeOwned,
        TReq: Serialize + ?Sized,
    {
        let url = self
            .base_url
            .join(path)
            .map_err(|err| KbblClientError::InvalidBaseUrl(err.to_string()))?;
        let response = self
            .http
            .request(method.clone(), url)
            .json(body)
            .send()
            .await?;
        Self::decode_response(response, method, path.to_string()).await
    }

    async fn get_json<TResp>(&self, path: &str) -> Result<TResp, KbblClientError>
    where
        TResp: DeserializeOwned,
    {
        let url = self
            .base_url
            .join(path)
            .map_err(|err| KbblClientError::InvalidBaseUrl(err.to_string()))?;
        let response = self.http.get(url).send().await?;
        Self::decode_response(response, reqwest::Method::GET, path.to_string()).await
    }

    async fn delete_json<TResp>(&self, path: &str) -> Result<TResp, KbblClientError>
    where
        TResp: DeserializeOwned,
    {
        let url = self
            .base_url
            .join(path)
            .map_err(|err| KbblClientError::InvalidBaseUrl(err.to_string()))?;
        let response = self.http.delete(url).send().await?;
        Self::decode_response(response, reqwest::Method::DELETE, path.to_string()).await
    }

    async fn decode_response<TResp>(
        response: reqwest::Response,
        method: reqwest::Method,
        path: String,
    ) -> Result<TResp, KbblClientError>
    where
        TResp: DeserializeOwned,
    {
        let status = response.status();
        if !status.is_success() {
            let detail = response
                .text()
                .await
                .ok()
                .and_then(|body| extract_error(&body));
            return Err(KbblClientError::Rejected {
                method,
                path,
                status,
                detail,
            });
        }
        Ok(response.json::<TResp>().await?)
    }
}

fn extract_error(body: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Some(error.to_string());
        }
        if let Some(detail) = value.get("detail").and_then(|v| v.as_str()) {
            return Some(detail.to_string());
        }
    }
    if body.trim().is_empty() {
        None
    } else {
        Some(body.trim().to_string())
    }
}

fn path_segment_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::OriginalUri,
        extract::State,
        http::{Method, StatusCode},
        response::IntoResponse,
        routing::{delete, get, post},
        Json, Router,
    };
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use tokio::net::TcpListener;

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct RecordedRequest {
        method: Method,
        path: String,
        body: Option<serde_json::Value>,
    }

    #[derive(Clone)]
    struct TestState {
        capture: Arc<Mutex<VecDeque<RecordedRequest>>>,
    }

    fn capture_request(
        capture: &Arc<Mutex<VecDeque<RecordedRequest>>>,
        method: Method,
        path: String,
        body: Option<serde_json::Value>,
    ) {
        capture
            .lock()
            .unwrap()
            .push_back(RecordedRequest { method, path, body });
    }

    async fn capture_create(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        (
            StatusCode::CREATED,
            Json(serde_json::json!({ "sid": "sid-123", "ignored": "extra" })),
        )
    }

    async fn capture_input(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        Json(serde_json::json!({ "ok": true }))
    }

    async fn capture_yolo(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        Json(serde_json::json!({ "ok": true }))
    }

    async fn capture_approval(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        capture_request(
            &state.capture,
            Method::POST,
            uri.path().to_string(),
            Some(body),
        );
        Json(serde_json::json!({ "ok": true }))
    }

    async fn capture_stop(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
    ) -> impl IntoResponse {
        capture_request(&state.capture, Method::DELETE, uri.path().to_string(), None);
        Json(serde_json::json!({ "ok": true, "removed": true }))
    }

    async fn capture_events(
        State(state): State<TestState>,
        OriginalUri(uri): OriginalUri,
    ) -> impl IntoResponse {
        capture_request(&state.capture, Method::GET, uri.to_string(), None);
        Json(serde_json::json!({
            "session_id": "sid-123",
            "events": [
                {
                    "id": 17,
                    "type": "message",
                    "ts": "2026-01-01T00:00:00Z",
                    "payload": { "text": "hello" }
                }
            ]
        }))
    }

    #[test]
    fn create_session_request_model_none_omits_key() {
        let req = CreateSessionRequest {
            workdir: "/work".into(),
            name: "s".into(),
            artifact_id: "a".into(),
            runtime: DelegatedRuntime::Codex,
            model: None,
            effort: None,
            worktree: None,
        };
        let value = serde_json::to_value(&req).unwrap();
        assert!(
            !value.as_object().unwrap().contains_key("model"),
            "model key must be absent when None, not serialized as null"
        );
    }

    #[test]
    fn create_session_request_model_some_serializes_as_string() {
        let req = CreateSessionRequest {
            workdir: "/work".into(),
            name: "s".into(),
            artifact_id: "a".into(),
            runtime: DelegatedRuntime::Codex,
            model: Some("gpt-4.1".into()),
            effort: None,
            worktree: None,
        };
        let value = serde_json::to_value(&req).unwrap();
        assert_eq!(
            value.get("model").and_then(|v| v.as_str()),
            Some("gpt-4.1"),
            "model key must be present with string value when Some"
        );
    }

    #[tokio::test]
    async fn create_session_posts_expected_body_and_reads_sid() {
        let capture = Arc::new(Mutex::new(VecDeque::new()));
        let state = TestState {
            capture: capture.clone(),
        };
        let app = Router::new()
            .route("/sessions", post(capture_create))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = KbblClient::new(format!("http://{addr}/")).unwrap();
        let snapshot = client
            .create_session(CreateSessionRequest {
                workdir: "/work/one".into(),
                name: "delegate-1".into(),
                artifact_id: "artifact-9".into(),
                runtime: DelegatedRuntime::Codex,
                model: Some("gpt-4.1".into()),
                effort: None,
                worktree: None,
            })
            .await
            .unwrap();

        assert_eq!(snapshot.sid, "sid-123");

        let mut capture = capture.lock().unwrap();
        let request = capture.pop_front().unwrap();
        assert_eq!(request.method, Method::POST);
        assert_eq!(request.path, "/sessions");
        assert_eq!(
            request.body.as_ref(),
            Some(&serde_json::json!({
                "workdir": "/work/one",
                "name": "delegate-1",
                "artifact_id": "artifact-9",
                "runtime": "codex",
                "model": "gpt-4.1"
            }))
        );

        join.abort();
    }

    #[tokio::test]
    async fn session_actions_use_expected_routes_and_bodies() {
        let capture = Arc::new(Mutex::new(VecDeque::new()));
        let state = TestState {
            capture: capture.clone(),
        };
        let app = Router::new()
            .route("/sessions", post(capture_create))
            .route("/:sid/input", post(capture_input))
            .route("/:sid/yolo", post(capture_yolo))
            .route("/:sid/approval", post(capture_approval))
            .route("/sessions/:sid", delete(capture_stop))
            .route("/:sid/events", get(capture_events))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = KbblClient::new(format!("http://{addr}/")).unwrap();
        let snapshot = client
            .create_session(CreateSessionRequest {
                workdir: "/work/one".into(),
                name: "delegate-1".into(),
                artifact_id: "artifact-9".into(),
                runtime: DelegatedRuntime::Codex,
                model: Some("gpt-4.1".into()),
                effort: None,
                worktree: None,
            })
            .await
            .unwrap();
        assert_eq!(snapshot.sid, "sid-123");

        let ack = client
            .send_input(
                &snapshot.sid,
                SendInputRequest {
                    text: "hello".into(),
                },
            )
            .await
            .unwrap();
        assert!(ack.ok);

        let yolo = client
            .set_yolo(&snapshot.sid, SetYoloRequest { enabled: true })
            .await
            .unwrap();
        assert!(yolo.ok);

        let approval = client
            .resolve_approval(
                &snapshot.sid,
                ResolveApprovalRequest {
                    request_id: "req-7".into(),
                    decision: ApprovalDecision::Approve,
                    scope: ApprovalScope::Always,
                },
            )
            .await
            .unwrap();
        assert!(approval.ok);

        let events = client.read_events_since(&snapshot.sid, -1).await.unwrap();
        assert_eq!(
            events,
            EventsSinceResponse {
                session_id: "sid-123".into(),
                events: vec![SessionEvent {
                    id: 17,
                    event_type: "message".into(),
                    ts: "2026-01-01T00:00:00Z".into(),
                    payload: serde_json::json!({ "text": "hello" }),
                }],
            }
        );

        let stop = client.stop_session(&snapshot.sid).await.unwrap();
        assert_eq!(
            stop,
            StopSessionResponse {
                ok: true,
                removed: Some(true),
                code: None,
            }
        );

        let capture = capture.lock().unwrap();
        let requests: Vec<_> = capture.iter().cloned().collect();
        assert_eq!(
            requests,
            vec![
                RecordedRequest {
                    method: Method::POST,
                    path: "/sessions".into(),
                    body: Some(serde_json::json!({
                        "workdir": "/work/one",
                        "name": "delegate-1",
                        "artifact_id": "artifact-9",
                        "runtime": "codex",
                        "model": "gpt-4.1"
                    })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: format!("/{}/input", snapshot.sid),
                    body: Some(serde_json::json!({ "text": "hello" })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: format!("/{}/yolo", snapshot.sid),
                    body: Some(serde_json::json!({ "enabled": true })),
                },
                RecordedRequest {
                    method: Method::POST,
                    path: format!("/{}/approval", snapshot.sid),
                    body: Some(serde_json::json!({
                        "request_id": "req-7",
                        "decision": "approve",
                        "scope": "always"
                    })),
                },
                RecordedRequest {
                    method: Method::GET,
                    path: format!("/{}/events?since=-1", snapshot.sid),
                    body: None,
                },
                RecordedRequest {
                    method: Method::DELETE,
                    path: format!("/sessions/{}", snapshot.sid),
                    body: None,
                },
            ]
        );

        join.abort();
    }

    #[tokio::test]
    async fn non_success_response_preserves_status_and_detail() {
        let app = Router::new().route(
            "/sessions",
            post(|| async {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({"error": "kbbl down"})),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = KbblClient::new(format!("http://{addr}/")).unwrap();
        let err = client
            .create_session(CreateSessionRequest {
                workdir: "/work/one".into(),
                name: "delegate-1".into(),
                artifact_id: "artifact-9".into(),
                runtime: DelegatedRuntime::Codex,
                model: None,
                effort: None,
                worktree: None,
            })
            .await
            .unwrap_err();

        match err {
            KbblClientError::Rejected { status, detail, .. } => {
                assert_eq!(status, StatusCode::BAD_GATEWAY);
                assert_eq!(detail.as_deref(), Some("kbbl down"));
            }
            other => panic!("unexpected error: {other:?}"),
        }

        join.abort();
    }

    #[tokio::test]
    async fn base_url_with_path_prefix_keeps_prefix_when_joining() {
        let capture = Arc::new(Mutex::new(VecDeque::new()));
        let state = TestState {
            capture: capture.clone(),
        };
        let app = Router::new()
            .route("/api/sessions", post(capture_create))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = KbblClient::new(format!("http://{addr}/api")).unwrap();
        let snapshot = client
            .create_session(CreateSessionRequest {
                workdir: "/work/one".into(),
                name: "delegate-1".into(),
                artifact_id: "artifact-9".into(),
                runtime: DelegatedRuntime::Codex,
                model: None,
                effort: None,
                worktree: None,
            })
            .await
            .unwrap();

        assert_eq!(snapshot.sid, "sid-123");
        let capture = capture.lock().unwrap();
        let request = capture.front().unwrap();
        assert_eq!(request.path, "/api/sessions");

        join.abort();
    }

    #[tokio::test]
    async fn plain_text_error_body_is_preserved() {
        let app = Router::new().route(
            "/sessions",
            post(|| async { (StatusCode::BAD_REQUEST, "plain text failure") }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let join = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = KbblClient::new(format!("http://{addr}/")).unwrap();
        let err = client
            .create_session(CreateSessionRequest {
                workdir: "/work/one".into(),
                name: "delegate-1".into(),
                artifact_id: "artifact-9".into(),
                runtime: DelegatedRuntime::Codex,
                model: None,
                effort: None,
                worktree: None,
            })
            .await
            .unwrap_err();

        match err {
            KbblClientError::Rejected { detail, .. } => {
                assert_eq!(detail.as_deref(), Some("plain text failure"));
            }
            other => panic!("unexpected error: {other:?}"),
        }

        join.abort();
    }

    #[test]
    fn client_construction_accepts_prefixed_base_urls() {
        let client = KbblClient::new("http://example.com/api").unwrap();
        assert_eq!(client.base_url.as_str(), "http://example.com/api/");
    }

    #[test]
    fn path_segment_encode_escapes_opaque_session_ids() {
        assert_eq!(
            path_segment_encode("sid/with?query#fragment.."),
            "sid%2Fwith%3Fquery%23fragment.."
        );
    }
}
