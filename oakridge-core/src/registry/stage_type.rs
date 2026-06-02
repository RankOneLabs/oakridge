use std::collections::HashMap;
use std::sync::Arc;
use async_trait::async_trait;
use serde_json::Value;
use crate::types::{Artifact, OutputSlot, StageInstanceId};
use crate::executor::{StageContext, StageHandle};

/// The interface that all stage-type implementations must satisfy.
///
/// Implementations are registered once and shared (via `Arc`) across all stage instances
/// of that type within a workflow run.
#[async_trait]
pub trait StageType: Send + Sync {
    /// Unique identifier for this stage type; matches the `stage_type` field in workflow graph nodes.
    fn id(&self) -> &str;

    /// Merge the definition-time config with resolved inputs and the run context,
    /// producing the config that will be present on `StageContext::config` at execute time.
    async fn build_config(
        &self,
        def_config: &Value,
        inputs: &HashMap<String, Artifact>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value>;

    /// Optionally contribute an HTTP callback surface nested under /executors/<id>.
    ///
    /// The returned router must be fully state-applied (Router<()>); the executor
    /// applies its own `.with_state(...)` internally before returning.
    fn http_routes(&self) -> Option<axum::Router> {
        None
    }

    /// Launch the stage. Returns a handle the scheduler can use to resume or cancel the stage.
    async fn execute(&self, ctx: StageContext) -> anyhow::Result<Box<dyn StageHandle>>;
}

/// Registry that maps stage-type IDs to their shared implementations.
pub struct StageTypeRegistry {
    types: HashMap<String, Arc<dyn StageType>>,
}

impl StageTypeRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self { types: HashMap::new() }
    }

    /// Register a stage type; keyed by `stage_type.id()`.
    pub fn register(&mut self, stage_type: Arc<dyn StageType>) {
        self.types.insert(stage_type.id().to_owned(), stage_type);
    }

    /// Look up a stage type by ID.
    pub fn get(&self, id: &str) -> Option<Arc<dyn StageType>> {
        self.types.get(id).cloned()
    }

    /// Iterate over all registered stage types.
    pub fn all(&self) -> impl Iterator<Item = &Arc<dyn StageType>> {
        self.types.values()
    }
}
