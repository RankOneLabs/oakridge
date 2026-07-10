use sqlx::SqlitePool;

use crate::db::queries;
use crate::types::WorkflowDef;

const DEV_FLOW_V1_JSON: &str = include_str!("../examples/dev_flow.json");
const DEV_FLOW_V2_JSON: &str = include_str!("../examples/dev_flow_v2.json");

pub async fn seed_builtin_workflow_defs(pool: &SqlitePool) -> crate::Result<()> {
    for (label, json_str) in [
        ("dev_flow.json", DEV_FLOW_V1_JSON),
        ("dev_flow_v2.json", DEV_FLOW_V2_JSON),
    ] {
        let def: WorkflowDef = serde_json::from_str(json_str).map_err(|e| {
            crate::Error::Validation(format!("failed to parse built-in {}: {}", label, e))
        })?;

        // Attempt the insert unconditionally so concurrent boots are safe: if two
        // processes both try to seed the same (name, version), the second hits the
        // UNIQUE constraint and we treat that as "already seeded" rather than an
        // error, instead of a check-then-insert race that could abort boot.
        match queries::insert_workflow_def(pool, &def).await {
            Ok(()) => {
                tracing::info!(name = %def.name, version = %def.version, id = %def.id.0, "seeded built-in workflow def");
            }
            Err(crate::Error::Db(sqlx::Error::Database(ref e))) if e.is_unique_violation() => {
                tracing::debug!(name = %def.name, version = %def.version, "built-in workflow def already exists, skipping seed");
            }
            Err(e) => return Err(e),
        }
    }

    Ok(())
}
