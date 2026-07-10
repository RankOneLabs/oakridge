pub mod collab;
pub mod config;
pub mod db;
pub mod events;
pub mod executor;
pub mod http;
pub mod registry;
pub mod scheduler;
pub mod seed;
pub mod types;

pub use config::Config;
pub use http::{boot, register_types};

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
