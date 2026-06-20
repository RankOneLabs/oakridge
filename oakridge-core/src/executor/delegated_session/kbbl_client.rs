use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::config::DelegatedRuntime;

#[derive(Debug, thiserror::Error)]
pub enum KbblClientError {
    #[error("invalid kbbl base url: {0}")]
    InvalidBaseUrl(String),
    #[error("request transport failed: {0}")]
    Transport(#[from] reqwest::Error),
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
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub sid: String,
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
        let base_url = reqwest::Url::parse(base_url.as_ref())
            .map_err(|err| KbblClientError::InvalidBaseUrl(err.to_string()))?;
        Ok(Self {
            base_url,
            http: reqwest::Client::new(),
        })
    }

    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> Result<SessionSnapshot, KbblClientError> {
        self.request_json(reqwest::Method::POST, "sessions", &request)
            .await
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
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
        return Some(error.to_string());
    }
    if let Some(detail) = value.get("detail").and_then(|v| v.as_str()) {
        return Some(detail.to_string());
    }
    if body.trim().is_empty() {
        None
    } else {
        Some(body.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::{Method, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[derive(Clone, Debug, Default)]
    struct Capture {
        method: Option<Method>,
        path: Option<String>,
        body: Option<serde_json::Value>,
    }

    #[derive(Clone)]
    struct TestState {
        capture: Arc<Mutex<Capture>>,
    }

    async fn capture_create(
        State(state): State<TestState>,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        let mut capture = state.capture.lock().unwrap();
        capture.method = Some(Method::POST);
        capture.path = Some("/sessions".to_string());
        capture.body = Some(body);
        (
            StatusCode::CREATED,
            Json(serde_json::json!({ "sid": "sid-123", "ignored": "extra" })),
        )
    }

    #[tokio::test]
    async fn create_session_posts_expected_body_and_reads_sid() {
        let capture = Arc::new(Mutex::new(Capture::default()));
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
            })
            .await
            .unwrap();

        assert_eq!(
            snapshot,
            SessionSnapshot {
                sid: "sid-123".into()
            }
        );

        let capture = capture.lock().unwrap();
        assert_eq!(capture.method, Some(Method::POST));
        assert_eq!(capture.path.as_deref(), Some("/sessions"));
        assert_eq!(
            capture.body.as_ref(),
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
}
