//! Pure checked-program evaluation. All dynamic inputs are revalidated at this boundary.
use serde_json::Value;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;

mod advance;
mod apply;
mod expression;
mod graph;
pub mod host;
mod reduce;
mod support;
mod typing;
mod wants;

use advance::*;
pub use apply::{step, step_with_limits};
pub use expression::eval_expression;
use expression::*;
pub use graph::is_valid_graph;
pub use graph::MAX_IDENT_CHARS;
use graph::*;
use reduce::*;
use support::*;
pub use support::{latest, EvaluationContext};
pub use typing::check_type;
pub use wants::action_id;
pub use wants::stage_actions;
use wants::*;
