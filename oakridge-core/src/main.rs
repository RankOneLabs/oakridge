use std::net::SocketAddr;

use oakridge_core::{boot, register_types, Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = Config::from_env()?;
    let port = cfg.port;
    let bind_addr = cfg.bind_addr;
    let (app, _coordinator) = boot(cfg, register_types).await?;

    let listener = tokio::net::TcpListener::bind((bind_addr, port)).await?;
    tracing::info!(%bind_addr, port, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
