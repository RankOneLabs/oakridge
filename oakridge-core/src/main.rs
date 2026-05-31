use oakridge_core::{boot, register_types, Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = Config::from_env();
    let port = cfg.port;
    let (app, _coordinator) = boot(cfg, register_types).await?;

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on port {port}");
    axum::serve(listener, app).await?;

    Ok(())
}
