// Generic review-collaboration domain types.
// Queries are in db/queries.rs; this module holds only the Rust domain shapes.

use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadStatus {
    Open,
    Resolved,
}

impl ThreadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ThreadStatus::Open => "open",
            ThreadStatus::Resolved => "resolved",
        }
    }

    pub fn from_str(s: &str) -> crate::Result<Self> {
        match s {
            "open" => Ok(ThreadStatus::Open),
            "resolved" => Ok(ThreadStatus::Resolved),
            other => Err(crate::Error::Validation(format!(
                "invalid thread status: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewItemStatus {
    Open,
    Resolved,
    Waived,
}

impl ReviewItemStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReviewItemStatus::Open => "open",
            ReviewItemStatus::Resolved => "resolved",
            ReviewItemStatus::Waived => "waived",
        }
    }

    pub fn from_str(s: &str) -> crate::Result<Self> {
        match s {
            "open" => Ok(ReviewItemStatus::Open),
            "resolved" => Ok(ReviewItemStatus::Resolved),
            "waived" => Ok(ReviewItemStatus::Waived),
            other => Err(crate::Error::Validation(format!(
                "invalid review item status: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CollabThread {
    pub id: Uuid,
    pub artifact_id: Uuid,
    /// Chain-root artifact id — used to group threads across revisions.
    pub revision_id: String,
    /// RFC-6901 pointer into the artifact body; None = whole-artifact thread.
    pub anchor: Option<String>,
    pub status: ThreadStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CollabMessage {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub body: String,
    pub author: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ReviewItem {
    pub id: Uuid,
    pub artifact_id: Uuid,
    /// Chain-root artifact id.
    pub revision_id: String,
    /// RFC-6901 pointer to the claim site within the artifact body.
    pub anchor: String,
    /// What the spec or analysis says (the expected claim).
    pub claim: String,
    /// What was found in reality (the observed value).
    pub reality: String,
    pub status: ReviewItemStatus,
    pub resolution: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Emitted by an ArtifactTypeDef's review_items_extractor; one entry per item.
#[derive(Debug, Clone)]
pub struct ReviewItemCandidate {
    pub anchor: String,
    pub claim: String,
    pub reality: String,
}
