use crate::types::ArtifactTypeId;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ArtifactReviewDescriptor {
    pub viewer: String,
    pub layout: String,
    pub sections: Vec<String>,
    pub action_labels: BTreeMap<String, String>,
}

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
    /// For review_items-capable types: extract materialized review item candidates from
    /// a freshly emitted artifact body. Called by `StageContext::emit` after the artifact
    /// is committed; each candidate is inserted as an open `review_item` row keyed to
    /// `revision_id = artifact.id` (the chain root for a freshly emitted artifact).
    /// `None` means items must be posted manually via POST /artifacts/:id/review_items.
    pub review_items_extractor: Option<fn(&Value) -> Vec<crate::collab::ReviewItemCandidate>>,
}

impl ArtifactTypeDef {
    /// Serializable presentation policy for the reusable artifact review shell.
    pub fn review_descriptor(&self) -> Option<ArtifactReviewDescriptor> {
        if !self.capabilities.reviewable {
            return None;
        }
        let (layout, sections): (&str, &[&str]) = match self.component_id.as_str() {
            "dev-spec-analysis-viewer" => (
                "document",
                &["summary", "findings", "requirements", "risks"],
            ),
            "dev-plan-viewer" => (
                "dag",
                &[
                    "summary",
                    "cohorts",
                    "dependency_order",
                    "scope",
                    "acceptance_criteria",
                    "risks",
                ],
            ),
            "dev-build-result-viewer" => (
                "report",
                &["summary", "changed_files", "tests", "known_issues"],
            ),
            "dev-assessment-viewer" => (
                "report",
                &[
                    "verdict",
                    "findings",
                    "test_evidence",
                    "recommended_next_actions",
                ],
            ),
            "dev-pr-summary-viewer" => {
                ("report", &["pr_url", "branch", "summary", "review_status"])
            }
            _ => ("document", &[]),
        };
        let action_labels = [
            ("approve", "Approve"),
            ("request_revision", "Request revision"),
            ("confirm_merged", "Confirm merged"),
            ("closed_without_merge", "Close without merge"),
        ]
        .into_iter()
        .map(|(action, label)| (action.to_owned(), label.to_owned()))
        .collect();
        Some(ArtifactReviewDescriptor {
            viewer: self.component_id.clone(),
            layout: layout.to_owned(),
            sections: sections
                .iter()
                .map(|section| (*section).to_owned())
                .collect(),
            action_labels,
        })
    }
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
