use std::path::PathBuf;

use axum::body::Body;
use axum::http::{header, HeaderValue, Request, StatusCode};
use tower::ServiceExt;
use uuid::Uuid;

use oakridge_core::{boot, register_types, Config};

fn temp_db_url() -> String {
    format!("sqlite:///tmp/oakridge-http-exposure-{}.db", Uuid::new_v4())
}

async fn app_with(cors_origins: Vec<HeaderValue>) -> axum::Router {
    let cfg = Config {
        port: 0,
        bind_addr: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        db_url: temp_db_url(),
        pwa_dir: PathBuf::from("/tmp"),
        cors_origins,
    };
    let (app, _coordinator) = boot(cfg, register_types).await.unwrap();
    app
}

async fn get_projects_with_origin(app: axum::Router, origin: &str) -> axum::http::Response<Body> {
    app.oneshot(
        Request::builder()
            .method("GET")
            .uri("/projects")
            .header(header::ORIGIN, origin)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn default_cors_does_not_allow_unrelated_origins() {
    let app = app_with(vec![]).await;
    let response = get_projects_with_origin(app, "https://example.com").await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());
}

#[tokio::test]
async fn delegated_session_is_registered_by_default() {
    let mut stage_types = oakridge_core::registry::StageTypeRegistry::new();
    let mut artifact_types = oakridge_core::registry::ArtifactTypeRegistry::new();
    register_types(&mut stage_types, &mut artifact_types);

    assert!(stage_types.get("session_agent").is_none());
    assert!(stage_types.get("delegated_session").is_some());
}

#[tokio::test]
async fn delegated_lbc_run_is_registered_by_default() {
    let mut stage_types = oakridge_core::registry::StageTypeRegistry::new();
    let mut artifact_types = oakridge_core::registry::ArtifactTypeRegistry::new();
    register_types(&mut stage_types, &mut artifact_types);

    assert!(stage_types.get("delegated_lbc_run").is_some());
}

#[tokio::test]
async fn allow_list_accepts_only_listed_origins() {
    let allowed = HeaderValue::from_static("https://dashboard.example");
    let app = app_with(vec![allowed.clone()]).await;

    let allowed_response = get_projects_with_origin(app.clone(), allowed.to_str().unwrap()).await;
    assert_eq!(allowed_response.status(), StatusCode::OK);
    assert_eq!(
        allowed_response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&allowed)
    );

    let denied_response = get_projects_with_origin(app, "https://example.com").await;
    assert_eq!(denied_response.status(), StatusCode::OK);
    assert!(denied_response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());
}
