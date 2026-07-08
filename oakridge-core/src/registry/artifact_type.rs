use crate::types::ArtifactTypeId;
use serde_json::Value;
use std::collections::HashMap;

/// Definition of a registered artifact type: its ID, body validator, and PWA mount hint.
pub struct ArtifactTypeDef {
    /// Unique identifier for this artifact type.
    pub id: ArtifactTypeId,
    /// Validates a JSON body against this artifact type's schema.
    /// Convention: `serde_json::from_value::<BodyStruct>(v.clone()).map(|_| ()).map_err(Into::into)`.
    pub validate: fn(&Value) -> crate::Result<()>,
    /// PWA component ID for rendering this artifact; opaque to the substrate.
    pub component_id: String,
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
}
