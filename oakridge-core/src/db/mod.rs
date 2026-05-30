use sqlx::{SqlitePool, sqlite::{SqliteConnectOptions, SqliteJournalMode}};
use std::str::FromStr;

pub mod queries;

pub async fn init_pool(db_url: &str) -> crate::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(db_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePool::connect_with(options).await?;
    sqlx::migrate!("src/db/migrations").run(&pool).await?;
    Ok(pool)
}
