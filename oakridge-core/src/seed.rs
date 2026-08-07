use sqlx::SqlitePool;

use crate::db::queries;
use crate::types::WorkflowDef;

const DEV_FLOW_V1_JSON: &str = include_str!("../examples/dev_flow.json");
const DEV_FLOW_V2_JSON: &str = include_str!("../examples/dev_flow_v2.json");
const DEV_FLOW_V4_JSON: &str = include_str!("../examples/dev_flow_v4.json");
const DEV_FLOW_V5_JSON: &str = include_str!("../examples/dev_flow_v5.json");
const DEV_FLOW_V6_JSON: &str = include_str!("../examples/dev_flow_v6.json");

pub async fn seed_builtin_workflow_defs(
    pool: &SqlitePool,
    stage_registry: &crate::registry::StageTypeRegistry,
    artifact_registry: &crate::registry::ArtifactTypeRegistry,
) -> crate::Result<()> {
    let mut definitions = Vec::new();
    for (label, json_str) in [
        ("dev_flow.json", DEV_FLOW_V1_JSON),
        ("dev_flow_v2.json", DEV_FLOW_V2_JSON),
        ("dev_flow_v4.json", DEV_FLOW_V4_JSON),
        ("dev_flow_v5.json", DEV_FLOW_V5_JSON),
        ("dev_flow_v6.json", DEV_FLOW_V6_JSON),
    ] {
        let def: WorkflowDef = serde_json::from_str(json_str).map_err(|e| {
            crate::Error::Validation(format!("failed to parse built-in {}: {}", label, e))
        })?;
        definitions.push((label, def));
    }
    for (label, def) in definitions {
        // Run the same graph/type/config validation as POST /workflow_defs so a
        // drifted example (unknown stage/artifact type, invalid def_config) is
        // surfaced at boot instead of silently failing later at run creation.
        //
        // This warns rather than aborts: boot() runs with a caller-provided type
        // registry (embedders and tests may register a minimal set), so a built-in
        // def whose types aren't registered in this process just isn't runnable
        // here — that shouldn't take down boot. A genuinely malformed def is still
        // rejected when a run is created (create_workflow_run validates too).
        if let Err(e) = crate::http::rest::validate_workflow_graph(
            stage_registry,
            artifact_registry,
            &def.graph,
        ) {
            tracing::warn!(
                def = %label,
                "built-in workflow def failed validation against the registered types \
                 and will not be runnable in this process: {e}"
            );
        }

        // Attempt the insert unconditionally so concurrent boots are safe: if two
        // processes both try to seed the same (name, version), the second hits the
        // UNIQUE constraint and we treat that as "already seeded" rather than an
        // error, instead of a check-then-insert race that could abort boot.
        match queries::insert_workflow_def(pool, &def).await {
            Ok(()) => {
                tracing::info!(name = %def.name, version = %def.version, id = %def.id.0, "seeded built-in workflow def");

                // Retire predecessors only on the boot that first seeds this
                // version. Re-running it every boot would fight an operator who
                // deliberately unarchived an older def, so the retire is a
                // one-time consequence of a new version arriving — not a policy
                // reasserted forever. This also sweeps up defs from earlier
                // builds of the seed list that no example file produces anymore.
                let retired =
                    queries::archive_workflow_defs_below_version(pool, &def.name, def.version)
                        .await?;
                if retired > 0 {
                    tracing::info!(
                        name = %def.name,
                        version = %def.version,
                        retired,
                        "archived workflow defs superseded by the newly seeded built-in"
                    );
                }
            }
            Err(crate::Error::Db(sqlx::Error::Database(ref e))) if e.is_unique_violation() => {
                tracing::debug!(name = %def.name, version = %def.version, "built-in workflow def already exists, skipping seed");
            }
            Err(e) => return Err(e),
        }
    }

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{ArtifactTypeRegistry, StageTypeRegistry};

    async fn seed_into_fresh_pool() -> SqlitePool {
        let path = format!("/tmp/oakridge_seed_test_{}.db", uuid::Uuid::new_v4());
        let pool = crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap();
        let stage_reg = StageTypeRegistry::new();
        let artifact_reg = ArtifactTypeRegistry::new();
        seed_builtin_workflow_defs(&pool, &stage_reg, &artifact_reg)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn seeding_retires_every_superseded_dev_flow_version() {
        let pool = seed_into_fresh_pool().await;

        let active = queries::list_workflow_defs(&pool, false).await.unwrap();
        let versions: Vec<i32> = active.iter().map(|d| d.version).collect();
        assert_eq!(
            versions,
            vec![6],
            "only the newest built-in should reach the launcher"
        );

        let all = queries::list_workflow_defs(&pool, true).await.unwrap();
        assert_eq!(all.len(), 5, "retired defs are kept, not deleted");
    }

    #[tokio::test]
    async fn re_seeding_does_not_re_retire_a_def_the_operator_unarchived() {
        let pool = seed_into_fresh_pool().await;
        let retired = queries::list_workflow_defs(&pool, true)
            .await
            .unwrap()
            .into_iter()
            .find(|d| d.version == 4)
            .expect("v4 should be seeded");

        queries::set_workflow_def_archived(&pool, &retired.id, false)
            .await
            .unwrap();

        // A second boot re-runs the seed; every insert now hits the unique
        // constraint, so nothing should re-archive.
        let stage_reg = StageTypeRegistry::new();
        let artifact_reg = ArtifactTypeRegistry::new();
        seed_builtin_workflow_defs(&pool, &stage_reg, &artifact_reg)
            .await
            .unwrap();

        let def = queries::get_workflow_def_by_id(&pool, &retired.id)
            .await
            .unwrap();
        assert!(
            !def.archived,
            "the seed must not overrule a deliberate unarchive on later boots"
        );
    }
}
