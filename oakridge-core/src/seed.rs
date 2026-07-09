use sqlx::SqlitePool;

use crate::db::queries;
use crate::types::WorkflowDef;

const DEV_FLOW_JSON: &str = include_str!("../examples/dev_flow.json");

pub async fn seed_builtin_workflow_defs(pool: &SqlitePool) -> crate::Result<()> {
    let def: WorkflowDef = serde_json::from_str(DEV_FLOW_JSON)
        .map_err(|e| crate::Error::Validation(format!("failed to parse built-in dev_flow.json: {}", e)))?;

    if queries::get_workflow_def_by_name_version(pool, &def.name, def.version)
        .await?
        .is_none()
    {
        tracing::info!(name = %def.name, version = %def.version, id = %def.id.0, "seeding built-in workflow def");
        queries::insert_workflow_def(pool, &def).await?;
    } else {
        tracing::debug!(name = %def.name, version = %def.version, "built-in workflow def already exists, skipping seed");
    }

    Ok(())
}
