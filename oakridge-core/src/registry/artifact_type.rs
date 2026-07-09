use crate::types::ArtifactTypeId;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// Capability flags for an artifact type; drives the PWA render surface.
#[derive(Serialize, Clone, Default)]
pub struct ArtifactCapabilities {
    /// Artifact can be reviewed (operator approval gate).
    pub reviewable: bool,
    /// Artifact supports threaded comments (cohort 5).
    pub commentable: bool,
    /// Artifact supports per-atom editing (cohort 5).
    pub atom_editable: bool,
    /// Review gate advances only after all review-items are resolved (cohort 5).
    pub review_items: bool,
}

/// Definition of a registered artifact type: its ID, body validator, and PWA mount hint.
pub struct ArtifactTypeDef {
    /// Unique identifier for this artifact type.
    pub id: ArtifactTypeId,
    /// Validates a JSON body against this artifact type's schema.
    /// Convention: `serde_json::from_value::<BodyStruct>(v.clone()).map(|_| ()).map_err(Into::into)`.
    pub validate: fn(&Value) -> crate::Result<()>,
    /// PWA component ID for rendering this artifact; opaque to the substrate.
    pub component_id: String,
    /// Capability flags for the PWA rendering and collaboration surface.
    pub capabilities: ArtifactCapabilities,
    /// RFC-6901 pointer prefixes that are addressable atoms (atom_editable types only).
    pub anchor_schema: Option<Vec<String>>,
}

/// Registry that maps artifact-type IDs to their definitions.
pub struct ArtifactTypeRegistry {
    types: HashMap<String, ArtifactTypeDef>,
}

impl ArtifactTypeRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            types: HashMap::new(),
        }
    }

    /// Register an artifact type definition; keyed by its `id`.
    pub fn register(&mut self, def: ArtifactTypeDef) {
        self.types.insert(def.id.clone(), def);
    }

    /// Look up an artifact type definition by ID.
    pub fn get(&self, id: &str) -> Option<&ArtifactTypeDef> {
        self.types.get(id)
    }

    /// Iterate over all registered artifact type definitions.
    pub fn all(&self) -> impl Iterator<Item = &ArtifactTypeDef> {
        self.types.values()
    }
}
