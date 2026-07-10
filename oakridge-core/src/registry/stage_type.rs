use crate::executor::{StageContext, StageHandle};
use crate::types::{InputSlot, OutputSlot, ResolvedInput, StageInstanceId};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Describes one step in a stage's gate flow.
#[derive(Serialize, Clone)]
pub struct GateStep {
    /// Gate type identifier (e.g. "artifact_approval", "merge_confirmation").
    pub gate_type: String,
}

/// Descriptor for the full gate flow a stage type produces when it parks.
///
/// Declared here and exposed via HTTP in this cohort; the scheduler consumes
/// `requires_zero_open_review_items` starting in cohort 5.
#[derive(Serialize, Clone)]
pub struct GateFlowDescriptor {
    /// Ordered gate steps the stage progresses through before completing.
    pub steps: Vec<GateStep>,
    /// When true, the final gate step will not advance until all review items
    /// are resolved. Declared now; wired in cohort 5.
    pub requires_zero_open_review_items: bool,
}

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
        inputs: &HashMap<String, ResolvedInput>,
        output_slots: &[OutputSlot],
        stage_instance_id: StageInstanceId,
        run_context: &Value,
    ) -> anyhow::Result<Value>;

    /// Validate definition-time config before a workflow definition is accepted.
    ///
    /// Implementations should use this for checks that do not require concrete
    /// run inputs, such as template existence, unsupported fields, and local
    /// config enums. The scheduler still calls `build_config` at activation
    /// time for run-context-dependent validation.
    fn validate_def_config(
        &self,
        _def_config: &Value,
        _input_slots: &[InputSlot],
        _output_slots: &[OutputSlot],
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Optionally contribute an HTTP callback surface nested under /executors/<id>.
    ///
    /// The returned router must carry no outstanding state parameter — i.e. it must
    /// already be a `Router<()>`. An implementation that needs per-executor state
    /// applies its own `.with_state(...)` before returning, so the router handed
    /// back can be nested directly.
    fn http_routes(&self) -> Option<axum::Router> {
        None
    }

    /// Describe the gate flow this stage type uses when it parks.
    ///
    /// The default is a single artifact-approval step (the historic one-step behaviour).
    /// Stage types that produce a two-step flow override this method.
    /// Declared in this cohort; `requires_zero_open_review_items` is wired in cohort 5.
    fn gate_flow(&self) -> GateFlowDescriptor {
        GateFlowDescriptor {
            steps: vec![GateStep {
                gate_type: "artifact_approval".into(),
            }],
            requires_zero_open_review_items: false,
        }
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
        Self {
            types: HashMap::new(),
        }
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
