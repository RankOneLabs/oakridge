use sqlx::SqlitePool;

use crate::db::queries;
use crate::types::WorkflowDef;

const DEV_FLOW_V1_JSON: &str = include_str!("../examples/dev_flow.json");
const DEV_FLOW_V2_JSON: &str = include_str!("../examples/dev_flow_v2.json");
const DEV_FLOW_V4_JSON: &str = include_str!("../examples/dev_flow_v4.json");
const DEV_FLOW_V5_JSON: &str = include_str!("../examples/dev_flow_v5.json");
const DEV_FLOW_V6_JSON: &str = include_str!("../examples/dev_flow_v6.json");
const DEV_FLOW_V7_JSON: &str = include_str!("../examples/dev_flow_v7.json");
const DEV_FLOW_V8_JSON: &str = include_str!("../examples/dev_flow_v8.json");
const DEV_FLOW_V9_JSON: &str = include_str!("../examples/dev_flow_v9.json");
const DEV_FLOW_V11_JSON: &str = include_str!("../examples/dev_flow_v11.json");
const DEV_FLOW_BATCH_ASSESSMENT_JSON: &str =
    include_str!("../examples/dev_flow_batch_assessment.json");

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
        ("dev_flow_v7.json", DEV_FLOW_V7_JSON),
        ("dev_flow_v8.json", DEV_FLOW_V8_JSON),
        ("dev_flow_v9.json", DEV_FLOW_V9_JSON),
        ("dev_flow_v11.json", DEV_FLOW_V11_JSON),
        (
            "dev_flow_batch_assessment.json",
            DEV_FLOW_BATCH_ASSESSMENT_JSON,
        ),
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
        // Boot may run with a caller-provided registry that intentionally omits
        // built-in types. In that case, leave the incompatible definition out of
        // storage rather than admitting a definition that cannot be used.
        if let Err(e) = crate::http::rest::validate_workflow_graph(
            stage_registry,
            artifact_registry,
            &def.graph,
        ) {
            tracing::warn!(
                def = %label,
                "built-in workflow def failed validation against the registered types \
                 and will not be seeded: {e}"
            );
            continue;
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

    fn builtin_registries() -> (StageTypeRegistry, ArtifactTypeRegistry) {
        let mut stage_registry = StageTypeRegistry::new();
        let mut artifact_registry = ArtifactTypeRegistry::new();
        crate::http::register_types(&mut stage_registry, &mut artifact_registry);
        (stage_registry, artifact_registry)
    }

    async fn seed_into_fresh_pool() -> SqlitePool {
        let path = format!("/tmp/oakridge_seed_test_{}.db", uuid::Uuid::new_v4());
        let pool = crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap();
        let (stage_reg, artifact_reg) = builtin_registries();
        seed_builtin_workflow_defs(&pool, &stage_reg, &artifact_reg)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn seeding_retires_every_superseded_dev_flow_version() {
        let (stage_registry, artifact_registry) = builtin_registries();
        let latest: WorkflowDef = serde_json::from_str(DEV_FLOW_V11_JSON).unwrap();
        crate::http::rest::validate_workflow_graph(
            &stage_registry,
            &artifact_registry,
            &latest.graph,
        )
        .unwrap();
        let pool = seed_into_fresh_pool().await;

        let active = queries::list_workflow_defs(&pool, false).await.unwrap();
        let versions: Vec<i32> = active
            .iter()
            .filter(|definition| definition.name == "dev-flow")
            .map(|definition| definition.version)
            .collect();
        assert_eq!(
            versions,
            vec![11],
            "only the newest built-in should reach the launcher"
        );

        let dev_flow_definitions: Vec<_> = queries::list_workflow_defs(&pool, true)
            .await
            .unwrap()
            .into_iter()
            .filter(|definition| definition.name == "dev-flow")
            .collect();
        assert_eq!(
            dev_flow_definitions.len(),
            9,
            "retired dev-flow defs are kept, not deleted"
        );
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
        let (stage_reg, artifact_reg) = builtin_registries();
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

    #[tokio::test]
    async fn new_builtin_version_supersedes_an_already_seeded_v8_definition() {
        let path = format!(
            "/tmp/oakridge_seed_upgrade_test_{}.db",
            uuid::Uuid::new_v4()
        );
        let pool = crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap();
        let v8: WorkflowDef = serde_json::from_str(DEV_FLOW_V8_JSON).unwrap();
        queries::insert_workflow_def(&pool, &v8).await.unwrap();

        let (stage_reg, artifact_reg) = builtin_registries();
        seed_builtin_workflow_defs(&pool, &stage_reg, &artifact_reg)
            .await
            .unwrap();

        let active: Vec<_> = queries::list_workflow_defs(&pool, false)
            .await
            .unwrap()
            .into_iter()
            .filter(|definition| definition.name == "dev-flow")
            .collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].version, 11);
        let config: crate::executor::delegated_session::config::DelegatedSessionDefConfig =
            serde_json::from_value(active[0].graph.stages["brief_writer"].config.clone()).unwrap();
        assert!(config.fan_out.is_none());
        assert_eq!(config.artifacts.unwrap().id_path, "/id");
    }

    #[tokio::test]
    async fn corrected_v11_supersedes_an_already_seeded_broken_v10_definition() {
        let path = format!(
            "/tmp/oakridge_seed_v10_repair_test_{}.db",
            uuid::Uuid::new_v4()
        );
        let pool = crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap();

        let mut broken_v10: WorkflowDef = serde_json::from_str(DEV_FLOW_V11_JSON).unwrap();
        broken_v10.id = crate::types::WorkflowDefId(uuid::Uuid::new_v4());
        broken_v10.version = 10;
        let bindings = broken_v10
            .graph
            .stages
            .get_mut("brief_writer")
            .unwrap()
            .config["slot_bindings"]
            .as_object_mut()
            .unwrap();
        bindings.remove("PLAN");
        bindings.insert(
            "BRIEF".into(),
            serde_json::json!({"from": "input", "input_name": "brief", "path": null}),
        );
        queries::insert_workflow_def(&pool, &broken_v10)
            .await
            .unwrap();

        let (stage_reg, artifact_reg) = builtin_registries();
        seed_builtin_workflow_defs(&pool, &stage_reg, &artifact_reg)
            .await
            .unwrap();

        let active: Vec<_> = queries::list_workflow_defs(&pool, false)
            .await
            .unwrap()
            .into_iter()
            .filter(|definition| definition.name == "dev-flow")
            .collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].version, 11);
        crate::http::rest::validate_workflow_graph(
            &stage_reg,
            &artifact_reg,
            &active[0].graph,
        )
        .unwrap();

        let persisted_v10 = queries::get_workflow_def_by_id(&pool, &broken_v10.id)
            .await
            .unwrap();
        assert!(persisted_v10.archived);
    }

    #[tokio::test]
    async fn batch_assessment_flow_is_seeded_as_an_additional_valid_definition() {
        let pool = seed_into_fresh_pool().await;
        let (stage_reg, artifact_reg) = builtin_registries();

        let definition = queries::get_workflow_def_by_name_version(
            &pool,
            "dev-flow-batch-assessment",
            1,
        )
        .await
        .unwrap()
        .expect("batch assessment workflow should be seeded");

        crate::http::rest::validate_workflow_graph(
            &stage_reg,
            &artifact_reg,
            &definition.graph,
        )
        .unwrap();
        let assessor = &definition.graph.stages["assessor"];
        assert!(assessor.inputs.iter().all(|input| {
            input.collect && input.delivery == crate::types::InputDelivery::ProducerComplete
        }));
        let config: crate::executor::delegated_session::config::DelegatedSessionDefConfig =
            serde_json::from_value(assessor.config.clone()).unwrap();
        assert!(config.fan_out.is_none());
    }

    #[tokio::test]
    async fn invalid_builtin_definitions_are_not_persisted() {
        let path = format!(
            "/tmp/oakridge_invalid_seed_test_{}.db",
            uuid::Uuid::new_v4()
        );
        let pool = crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap();

        seed_builtin_workflow_defs(
            &pool,
            &StageTypeRegistry::new(),
            &ArtifactTypeRegistry::new(),
        )
        .await
        .unwrap();

        assert!(queries::list_workflow_defs(&pool, true)
            .await
            .unwrap()
            .is_empty());
    }
}
