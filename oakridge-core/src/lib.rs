pub mod types;
pub mod db;
pub mod registry;
pub mod executor;
pub mod scheduler;
pub mod events;
pub mod http;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{entity} not found: {id}")]
    NotFound { entity: String, id: String },
    #[error("validation error: {0}")]
    Validation(String),
    #[error("registry miss: {0}")]
    RegistryMiss(String),
}

pub type Result<T> = std::result::Result<T, Error>;
