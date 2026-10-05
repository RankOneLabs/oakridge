//! Source contracts from the core replacement specification, sections 3–5.
//! JSON is accepted only as source literals and ingress payloads. Evaluators use CheckedValue.
mod checked;
pub mod protocol;
mod source;
mod values;
pub use checked::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use source::*;
pub use values::*;
pub type CoreResult<T> = Result<T, DomainError>;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DomainErrorKind {
    MissingSymbol,
    DuplicateSymbol,
    UnsupportedVersion,
    UnresolvedContent,
    InvalidSchema,
    RecursiveSchema,
    IncompatiblePort,
    WrongBrand,
    MissingBinding,
    UnguardedOptional,
    PrivateRead,
    UndeclaredTrigger,
    NonExhaustiveMatch,
    ConflictingWrite,
    InvalidAssignment,
    DuplicateLaunch,
    CyclicPrerequisite,
    InvalidTemplate,
    UnreachableDeclaration,
    DeadRegion,
    UnhandledCommand,
    UnsupportedProvider,
    UnavailableOperation,
    UnsupportedAuthorization,
    UnsupportedPublication,
    UnsupportedPresentation,
    InvalidPayload,
    InvalidSnapshot,
    ResourceLimit,
    UnknownConstruct,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DomainError {
    pub operation: Box<str>,
    pub entity_id: Box<str>,
    pub kind: DomainErrorKind,
    pub detail: Box<str>,
    pub path: Box<str>,
    pub expected: Box<str>,
    pub actual: Box<str>,
}
impl DomainError {
    pub fn new(
        kind: DomainErrorKind,
        entity: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        let entity_id = entity.into().into_boxed_str();
        Self {
            operation: "compile".into(),
            path: entity_id.clone(),
            entity_id,
            kind,
            detail: detail.into().into_boxed_str(),
            expected: "".into(),
            actual: "".into(),
        }
    }
    pub fn contracts(mut self, expected: impl Into<String>, actual: impl Into<String>) -> Self {
        self.expected = expected.into().into_boxed_str();
        self.actual = actual.into().into_boxed_str();
        self
    }
}
macro_rules! id {
    ($($name:ident),*) => {$(
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl From<&str> for $name { fn from(value: &str) -> Self { Self(value.into()) } }
        impl std::fmt::Display for $name { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { self.0.fmt(f) } }
    )*};
}
id!(
    SchemaId,
    ScopeKey,
    WorkerKey,
    ActionKey,
    SymbolKey,
    NodeId,
    InstanceId,
    TriggerId,
    BundleDigest
);
