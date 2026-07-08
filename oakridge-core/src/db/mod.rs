use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
    SqlitePool,
};
use std::str::FromStr;
use std::time::Duration;

pub mod queries;

pub async fn init_pool(db_url: &str) -> crate::Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(db_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePool::connect_with(options).await?;
    sqlx::migrate!("src/db/migrations").run(&pool).await?;
    Ok(pool)
}
