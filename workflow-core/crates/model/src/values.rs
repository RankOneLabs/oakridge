use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedValue {
    pub schema: SchemaId,
    pub data: CheckedData,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckedData {
    Boolean {
        value: bool,
    },
    Integer {
        value: i64,
    },
    String {
        value: String,
    },
    Enum {
        variant: String,
    },
    Record {
        fields: Vec<CheckedField>,
        dictionary: Vec<DictionaryEntry>,
    },
    List {
        items: Vec<CheckedValue>,
    },
    Optional {
        value: Option<Box<CheckedValue>>,
    },
    Variant {
        variant: String,
        value: Box<CheckedValue>,
    },
    Reference {
        brand: ReferenceBrand,
        id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckedField {
    pub field_id: usize,
    pub value: Option<CheckedValue>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DictionaryEntry {
    pub key: String,
    pub value: CheckedValue,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VersionedValue {
    pub identity: String,
    pub version: u64,
    pub root: ReferenceRoot,
    pub value: CheckedValue,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub owner: InstanceId,
    pub scope: ScopeKey,
    pub version: u64,
    pub input: CheckedValue,
    pub state: CheckedValue,
    pub trigger: Trigger,
    pub observations: Vec<VersionedValue>,
    pub timestamp_ms: i64,
    pub random_seed: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub id: TriggerId,
    pub key: SymbolKey,
    pub payload: CheckedValue,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadVersion {
    pub identity: String,
    pub version: u64,
}
