//! Pure checked-program evaluation. All dynamic inputs are revalidated at this boundary.
use serde_json::Value;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use workflow_model::*;

fn rejected(reason: impl Into<String>) -> StepError {
    StepError::Rejected {
        reason: reason.into(),
    }
}
fn invalid(detail: impl Into<String>) -> StepError {
    StepError::Invalid {
        detail: detail.into(),
        unit: None,
    }
}
/// Attribute an error raised while advancing `unit` to it (D-V4): a
/// refusal there stalls the run at that unit rather than refusing the
/// event for what it is, and an inconsistency names where it was found.
fn advancing(unit: &UnitId) -> impl Fn(StepError) -> StepError + '_ {
    move |error| match error {
        StepError::Rejected { reason } => StepError::Stalled {
            unit: unit.clone(),
            reason,
        },
        StepError::Invalid { detail, unit: None } => StepError::Invalid {
            detail,
            unit: Some(unit.clone()),
        },
        attributed => attributed,
    }
}
struct EvaluationContext<'a> {
    limits: &'a ResourceLimits,
    remaining: Cell<usize>,
    exhausted: Cell<bool>,
    limit_error: Cell<Option<&'static str>>,
}
impl<'a> EvaluationContext<'a> {
    fn new(limits: &'a ResourceLimits) -> Self {
        Self {
            limits,
            remaining: Cell::new(limits.evaluation_budget),
            exhausted: Cell::new(false),
            limit_error: Cell::new(None),
        }
    }
    fn charge(&self) -> bool {
        let remaining = self.remaining.get();
        if remaining == 0 {
            self.exhausted.set(true);
            false
        } else {
            self.remaining.set(remaining - 1);
            true
        }
    }
    fn check_value(&self, value: &Value) -> Result<(), StepError> {
        self.limits.check_value(value).map_err(rejected)
    }
    fn check_list_len(&self, len: usize) -> bool {
        if len > self.limits.max_list_items {
            self.limit_error.set(Some("max_list_items exceeded"));
            false
        } else {
            true
        }
    }
}
fn latest<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifact: &SymbolKey,
) -> Option<&'a RevisionState> {
    state
        .revisions
        .iter()
        .rev()
        .find(|r| r.unit == *unit && r.artifact == *artifact)
}
fn checked_stage<'a>(
    program: &'a CheckedWorkflow,
    unit: &UnitState,
) -> Result<&'a CheckedStage, StepError> {
    let key = unit
        .stage
        .as_ref()
        .ok_or_else(|| invalid("unit is a group"))?;
    program
        .stages
        .iter()
        .find(|stage| stage.key == *key)
        .ok_or_else(|| invalid(format!("checked stage {key} absent")))
}
fn worker<'a>(stage: &'a CheckedStage, key: &WorkerKey) -> Result<&'a CheckedWorker, StepError> {
    stage
        .workers
        .iter()
        .find(|worker| worker.key() == key)
        .ok_or_else(|| rejected(format!("worker {key} absent")))
}
fn attempt<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
) -> Option<&'a AttemptState> {
    state
        .attempts
        .iter()
        .rev()
        .find(|a| a.unit == *unit && a.worker == *worker)
}
/// Revision and decision ids are prefixed with their unit, which is already
/// run-scoped, so they are unique across units and runs. A unit's snapshot
/// always carries all of that unit's revisions and decisions.
fn revision_id(state: &StepSnapshot, unit: &UnitId, artifact: &SymbolKey) -> RevisionId {
    let seq = state
        .revisions
        .iter()
        .filter(|revision| revision.unit == *unit && revision.artifact == *artifact)
        .count()
        + 1;
    RevisionId(format!("{}:{}:{seq}", unit.0, artifact.0))
}
fn decision_id(state: &StepSnapshot, unit: &UnitId) -> DecisionId {
    let seq = state
        .decisions
        .iter()
        .filter(|decision| decision.unit == *unit)
        .count()
        + 1;
    DecisionId(format!("{}:d{seq}", unit.0))
}
fn path(value: &Value, parts: &[&str]) -> Option<Value> {
    let mut current = value;
    for part in parts {
        current = current.get(*part)?;
    }
    Some(current.clone())
}
/// What names are bound while an expression is walked: the collection
/// member (`each`), the list element inside a list function (`item`), and
/// the body a validate check binds to its artifact's key.
#[derive(Clone, Copy)]
struct Bindings<'a> {
    each: Option<&'a Value>,
    item: Option<&'a Value>,
    body: Option<(&'a str, &'a Value)>,
}
/// Walk a resolved stage expression. The compiler already type-checked it,
/// so an unresolvable read is None rather than an error.
fn eval_expression(
    expression: &Expression,
    unit: &UnitState,
    state: &StepSnapshot,
    each: Option<&Value>,
    own_body: Option<(&str, &Value)>,
    context: &EvaluationContext<'_>,
) -> Result<Option<Value>, StepError> {
    let bindings = Bindings {
        each,
        item: None,
        body: own_body,
    };
    let result = eval_expression_inner(expression, unit, state, bindings, context);
    if let Some(reason) = context.limit_error.get() {
        return Err(rejected(reason));
    }
    if context.exhausted.get() {
        return Err(rejected("evaluation_budget exceeded"));
    }
    if let Some(value) = &result {
        context.check_value(value)?;
    }
    Ok(result)
}
/// The graph check behind `valid_graph`: every key a legal ident and
/// unique, every dependency list free of repeats and naming a key, and no
/// cycle. Malformed members fail the check rather than the evaluation.
fn is_valid_graph(items: &[Value], key_field: &str, dependencies_field: &str) -> bool {
    let mut keys = BTreeSet::new();
    let mut edges = BTreeMap::new();
    for item in items {
        let Some(key) = item.get(key_field).and_then(Value::as_str) else {
            return false;
        };
        if !is_ident(key) || !keys.insert(key) {
            return false;
        }
        let Some(dependencies) = item.get(dependencies_field).and_then(Value::as_array) else {
            return false;
        };
        let mut named = BTreeSet::new();
        for dependency in dependencies {
            let Some(dependency) = dependency.as_str() else {
                return false;
            };
            if !named.insert(dependency) {
                return false;
            }
        }
        edges.insert(key, named);
    }
    if edges
        .values()
        .flatten()
        .any(|dependency| !keys.contains(dependency))
    {
        return false;
    }
    is_acyclic(&edges)
}
/// Kahn's algorithm over a ready queue, O(nodes + edges): whether every
/// node becomes reachable from an empty prerequisite set. Every
/// prerequisite must itself be a node.
fn is_acyclic<K: Ord + Copy>(prerequisites: &BTreeMap<K, BTreeSet<K>>) -> bool {
    let mut waiting: BTreeMap<K, usize> = prerequisites
        .iter()
        .map(|(node, named)| (*node, named.len()))
        .collect();
    let mut dependents: BTreeMap<K, Vec<K>> = BTreeMap::new();
    for (node, named) in prerequisites {
        for prerequisite in named {
            dependents.entry(*prerequisite).or_default().push(*node);
        }
    }
    let mut ready: Vec<K> = waiting
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(node, _)| *node)
        .collect();
    let mut reached = 0usize;
    while let Some(node) = ready.pop() {
        reached += 1;
        for dependent in dependents.get(&node).map(Vec::as_slice).unwrap_or_default() {
            let count = waiting
                .get_mut(dependent)
                .expect("every dependent is a node");
            *count -= 1;
            if *count == 0 {
                ready.push(*dependent);
            }
        }
    }
    reached == prerequisites.len()
}
fn is_ident(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_IDENT_CHARS
        && !text
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
}
fn eval_expression_inner(
    expression: &Expression,
    unit: &UnitState,
    state: &StepSnapshot,
    bindings: Bindings<'_>,
    context: &EvaluationContext<'_>,
) -> Option<Value> {
    if !context.charge() {
        return None;
    }
    fn decided(
        state: &StepSnapshot,
        unit: &UnitState,
        artifact: &SymbolKey,
        effect: DecisionEffect,
    ) -> Value {
        Value::Bool(latest(state, &unit.id, artifact).is_some_and(|revision| {
            state.decisions.iter().any(|decision| {
                decision.unit == unit.id
                    && decision.target == revision.id
                    && decision.effect == effect
            })
        }))
    }
    let eval = |inner: &Expression| eval_expression_inner(inner, unit, state, bindings, context);
    let eval_item = |inner: &Expression, item: &Value| {
        let bound = Bindings {
            item: Some(item),
            ..bindings
        };
        eval_expression_inner(inner, unit, state, bound, context)
    };
    let boolean = |inner: &Expression| eval(inner)?.as_bool();
    let list = |inner: &Expression| -> Option<Vec<Value>> {
        let Value::Array(items) = eval(inner)? else {
            return None;
        };
        context.check_list_len(items.len()).then_some(items)
    };
    let integers = |left: &Expression, right: &Expression| -> Option<(i64, i64)> {
        Some((eval(left)?.as_i64()?, eval(right)?.as_i64()?))
    };
    match expression {
        Expression::Literal { value, .. } => Some(value.clone()),
        Expression::Len { value } => Some(Value::from(match eval(value)? {
            Value::String(text) => text.chars().count(),
            Value::Array(items) => items.len(),
            _ => return None,
        })),
        Expression::GreaterThan { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left > right))
        }
        Expression::GreaterOrEqual { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left >= right))
        }
        Expression::LessThan { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left < right))
        }
        Expression::LessOrEqual { left, right } => {
            let (left, right) = integers(left, right)?;
            Some(Value::Bool(left <= right))
        }
        // `a and b` reads b only where a holds, so a false a short-circuits
        // and an unresolved a leaves the conjunction unresolved.
        Expression::All { items } => {
            for item in items {
                if !boolean(item)? {
                    return Some(Value::Bool(false));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Any { items } => {
            for item in items {
                if boolean(item)? {
                    return Some(Value::Bool(true));
                }
            }
            Some(Value::Bool(false))
        }
        Expression::Not { value } => Some(Value::Bool(!boolean(value)?)),
        Expression::Equals { left, right } => Some(Value::Bool(eval(left)? == eval(right)?)),
        Expression::Every { source, predicate } => {
            for item in list(source)? {
                if !eval_item(predicate, &item)?.as_bool()? {
                    return Some(Value::Bool(false));
                }
            }
            Some(Value::Bool(true))
        }
        Expression::Filter { source, predicate } => {
            let mut kept = Vec::new();
            for item in list(source)? {
                if eval_item(predicate, &item)?.as_bool()? {
                    kept.push(item);
                }
            }
            Some(Value::Array(kept))
        }
        Expression::Contains { source, value } => {
            let value = eval(value)?;
            Some(Value::Bool(list(source)?.contains(&value)))
        }
        Expression::Lookup {
            source,
            key_field,
            key,
        } => {
            let key = eval(key)?;
            let mut matches = list(source)?
                .into_iter()
                .filter(|item| item.get(key_field) == Some(&key));
            let found = matches.next()?;
            // Exactly one: an ambiguous key resolves to nothing.
            matches.next().is_none().then_some(found)
        }
        Expression::Field { value, key } => eval(value)?.get(key).cloned(),
        Expression::CheckCollection {
            source,
            key_field,
            dependencies_field,
        } => Some(Value::Bool(is_valid_graph(
            &list(source)?,
            key_field,
            dependencies_field,
        ))),
        Expression::Record { fields, .. } => {
            let mut record = serde_json::Map::new();
            for field in fields {
                record.insert(field.key.clone(), eval(&field.value)?);
            }
            Some(Value::Object(record))
        }
        Expression::List { items, .. } => {
            if !context.check_list_len(items.len()) {
                return None;
            }
            items
                .iter()
                .map(eval)
                .collect::<Option<Vec<_>>>()
                .map(Value::Array)
        }
        Expression::Map {
            source,
            value: projection,
            ..
        } => list(source)?
            .iter()
            .map(|item| eval_item(projection, item))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Expression::Reference {
            root,
            path: segments,
        } => {
            let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
            let read = |value: &Value| -> Option<Value> {
                if parts.is_empty() {
                    Some(value.clone())
                } else {
                    path(value, &parts)
                }
            };
            match root {
                ReferenceRoot::UnitInput => read(&unit.input),
                ReferenceRoot::EachMember => read(bindings.each?),
                ReferenceRoot::Item => read(bindings.item?),
                ReferenceRoot::ValidationBody { artifact } => {
                    let (bound, body) = bindings.body?;
                    (bound == artifact.0).then(|| read(body)).flatten()
                }
                ReferenceRoot::Latest { artifact } => {
                    read(&latest(state, &unit.id, artifact)?.body)
                }
                ReferenceRoot::Published { artifact } => {
                    Some(Value::Bool(latest(state, &unit.id, artifact).is_some()))
                }
                ReferenceRoot::Approved { artifact } => {
                    Some(decided(state, unit, artifact, DecisionEffect::Approve))
                }
                ReferenceRoot::ChangesRequested { artifact } => Some(decided(
                    state,
                    unit,
                    artifact,
                    DecisionEffect::RequestChanges,
                )),
                ReferenceRoot::MemberOutcomes { unit: collection } => {
                    let mut values = Vec::new();
                    let mut children: Vec<_> = state
                        .units
                        .iter()
                        .filter(|candidate| {
                            candidate.parent.as_ref() == Some(&unit.id)
                                && candidate.declaration.0 == collection.0
                        })
                        .collect();
                    children.sort_by(|left, right| left.id.cmp(&right.id));
                    if !context.check_list_len(children.len()) {
                        return None;
                    }
                    for child in children {
                        let UnitStatus::Done { outcome } = &child.status else {
                            return None;
                        };
                        values.push(read(outcome)?);
                    }
                    Some(Value::Array(values))
                }
                ReferenceRoot::UnitOutcome { unit: child_key } => {
                    // The compiler admits only a non-collection unit
                    // here, so its declaration names exactly one member.
                    let child = state.units.iter().find(|candidate| {
                        candidate.parent.as_ref() == Some(&unit.id)
                            && candidate.declaration == *child_key
                    })?;
                    let UnitStatus::Done { outcome } = &child.status else {
                        return None;
                    };
                    read(outcome)
                }
            }
        }
    }
}
fn eval_fields(
    fields: &[CheckedNamedExpression],
    unit: &UnitState,
    state: &StepSnapshot,
    each: Option<&Value>,
    context: &EvaluationContext<'_>,
) -> Result<Option<Value>, StepError> {
    let mut result = serde_json::Map::new();
    for field in fields {
        let Some(value) =
            eval_expression(&field.value.expression, unit, state, each, None, context)?
        else {
            return Ok(None);
        };
        result.insert(field.key.clone(), value);
    }
    Ok(Some(Value::Object(result)))
}
fn latest_retry<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
) -> Option<&'a EventId> {
    state
        .retry_events
        .iter()
        .rev()
        .find(|(u, w, _)| u == unit && w == worker)
        .map(|(_, _, id)| id)
}
/// A retry authorizes exactly one attempt: once any attempt of the worker
/// carries it, it is spent.
fn is_retry_spent(
    state: &StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
    retry: &EventId,
) -> bool {
    state.attempts.iter().any(|attempt| {
        attempt.unit == *unit
            && attempt.worker == *worker
            && matches!(&attempt.cause, Cause::Retry { event } if event == retry)
    })
}
/// The first 16 bytes of a value's SHA-256 over its wire JSON (object
/// keys sorted), as 32 hex characters: bounded however large the value.
fn json_digest(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.to_string().as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
/// The digest a periodic watch is pinned to: its resolved inputs.
fn inputs_digest(inputs: &Value) -> String {
    json_digest(inputs)
}
/// Which watch a periodic worker wants (D-V1). Its latest watch while that
/// one is pinned to these inputs; otherwise a new one replacing the
/// worker's latest action, which may be an earlier watch or a retry.
fn periodic_cause(
    state: &StepSnapshot,
    unit: &UnitId,
    worker: &WorkerKey,
    inputs: String,
) -> Cause {
    let Some(previous) = attempt(state, unit, worker) else {
        return Cause::Periodic {
            inputs,
            replaces: None,
        };
    };
    match &previous.cause {
        Cause::Periodic { inputs: pinned, .. } if *pinned == inputs => previous.cause.clone(),
        _ => Cause::Periodic {
            inputs,
            replaces: Some(previous.action_id.clone()),
        },
    }
}
/// Whether a worker that creates `artifact` has an attempt open, so its
/// latest revision may yet be followed by the rest of that attempt's output.
fn is_creator_working(
    definition: &CheckedStage,
    state: &StepSnapshot,
    unit: &UnitId,
    artifact: &SymbolKey,
) -> bool {
    definition
        .workers
        .iter()
        .filter(|worker| worker.creates().contains(artifact))
        .any(|worker| {
            attempt(state, unit, worker.key()).is_some_and(|current| {
                matches!(
                    current.status,
                    AttemptStatus::Pending | AttemptStatus::Running
                )
            })
        })
}
/// Whether an expression reads an artifact of its unit: `latest`,
/// `published`, `approved` or `changes_requested` of it.
fn reads_artifact(expression: &Expression, artifact: &SymbolKey) -> bool {
    let reads = |inner: &Expression| reads_artifact(inner, artifact);
    match expression {
        Expression::Literal { .. } => false,
        Expression::Reference { root, .. } => matches!(
            root,
            ReferenceRoot::Latest { artifact: read }
                | ReferenceRoot::Published { artifact: read }
                | ReferenceRoot::Approved { artifact: read }
                | ReferenceRoot::ChangesRequested { artifact: read }
                if read == artifact
        ),
        Expression::Record { fields, .. } => fields.iter().any(|field| reads(&field.value)),
        Expression::List { items, .. } | Expression::All { items } | Expression::Any { items } => {
            items.iter().any(reads)
        }
        Expression::Equals { left, right }
        | Expression::GreaterThan { left, right }
        | Expression::GreaterOrEqual { left, right }
        | Expression::LessThan { left, right }
        | Expression::LessOrEqual { left, right } => reads(left) || reads(right),
        Expression::Len { value } | Expression::Not { value } | Expression::Field { value, .. } => {
            reads(value)
        }
        Expression::Map { source, value, .. }
        | Expression::Contains { source, value }
        | Expression::Lookup {
            source, key: value, ..
        }
        | Expression::Filter {
            source,
            predicate: value,
        }
        | Expression::Every {
            source,
            predicate: value,
        } => reads(source) || reads(value),
        Expression::CheckCollection { source, .. } => reads(source),
    }
}
/// The artifacts of a stage's watches that have not observed what they
/// watch now: a watch whose guard holds and whose inputs resolve, but whose
/// worker's latest action is not pinned to those inputs, or has never run
/// successfully. Such an artifact's latest revision is about inputs the watch
/// no longer watches (a pull request since replaced), so the stage is not
/// judged on it until the replacing watch has observed.
fn unobserved_watch_artifacts(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Vec<SymbolKey>, StepError> {
    let checked = checked_stage(program, unit)?;
    let mut unobserved = Vec::new();
    for checked_worker in &checked.workers {
        if !is_periodic(checked_worker) {
            continue;
        }
        let worker_key = checked_worker.key();
        if !holds(checked_worker.when(), unit, state, context)? {
            continue;
        }
        let Some(inputs) = eval_fields(checked_worker.inputs(), unit, state, None, context)? else {
            continue;
        };
        let digest = inputs_digest(&inputs);
        let is_observed = attempt(state, &unit.id, worker_key).is_some_and(|latest| {
            matches!(&latest.cause, Cause::Periodic { inputs: pinned, .. } if *pinned == digest)
                && state.attempts.iter().any(|candidate| {
                    candidate.action_id == latest.action_id
                        && matches!(candidate.status, AttemptStatus::Succeeded)
                })
        });
        if !is_observed {
            unobserved.extend(checked_worker.creates().iter().cloned());
        }
    }
    Ok(unobserved)
}
/// Whether an expression reads any of the given artifacts.
fn reads_any(expression: &Expression, artifacts: &[SymbolKey]) -> bool {
    artifacts
        .iter()
        .any(|artifact| reads_artifact(expression, artifact))
}
fn is_periodic(worker: &CheckedWorker) -> bool {
    matches!(worker, CheckedWorker::Code { every: Some(_), .. })
}
fn can_run(state: &StepSnapshot, unit: &UnitId, worker: &WorkerKey) -> Option<Option<Cause>> {
    let Some(previous) = attempt(state, unit, worker) else {
        return Some(None);
    };
    match previous.status {
        AttemptStatus::Pending | AttemptStatus::Running => None,
        AttemptStatus::Failed { .. } => {
            // A later failure waits for a new retry once the latest is spent.
            let retry = latest_retry(state, unit, worker)?;
            if is_retry_spent(state, unit, worker, retry) {
                None
            } else {
                Some(Some(Cause::Retry {
                    event: retry.clone(),
                }))
            }
        }
        AttemptStatus::Succeeded => Some(None),
    }
}
/// Whether an optional guard holds; no guard always holds, and an
/// unresolved one does not.
fn holds(
    guard: Option<&CheckedStageExpression>,
    unit: &UnitState,
    state: &StepSnapshot,
    context: &EvaluationContext<'_>,
) -> Result<bool, StepError> {
    let Some(guard) = guard else {
        return Ok(true);
    };
    Ok(
        eval_expression(&guard.expression, unit, state, None, None, context)?
            == Some(Value::Bool(true)),
    )
}
fn stage_actions(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Vec<Action>, StepError> {
    let checked = checked_stage(program, unit)?;
    let mut wanted = Vec::new();
    for checked_worker in &checked.workers {
        let worker_key = checked_worker.key();
        let Some(retry) = can_run(state, &unit.id, worker_key) else {
            continue;
        };
        if !holds(checked_worker.when(), unit, state, context)? {
            continue;
        }
        let candidate = match checked_worker {
            CheckedWorker::Agent {
                creates,
                reviews: Some(subject),
                ..
            } => {
                // The subject's creator may still replace it (a revise
                // publishes the new build before its PR): review only what
                // a finished attempt left.
                if is_creator_working(checked, state, &unit.id, subject) {
                    continue;
                }
                let Some(subject) = latest(state, &unit.id, subject) else {
                    continue;
                };
                let already = creates.iter().all(|artifact| {
                    state.revisions.iter().any(|r| {
                        r.unit == unit.id
                            && r.artifact == *artifact
                            && r.subject.as_ref() == Some(&subject.id)
                    })
                });
                if already {
                    None
                } else {
                    Some((
                        Mode::Review,
                        Cause::ReviewOf {
                            revision: subject.id.clone(),
                        },
                    ))
                }
            }
            CheckedWorker::Agent {
                creates,
                reviews: None,
                ..
            } => {
                if creates
                    .iter()
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    changes_requested(state, &unit.id, creates).map(|decision| {
                        (
                            Mode::Revise,
                            Cause::ChangesRequested {
                                decision: decision.id.clone(),
                            },
                        )
                    })
                }
            }
            // Part 1 §5.2 rule 4: wanted only once its inputs resolve.
            CheckedWorker::Code { every: Some(_), .. } => {
                eval_fields(checked_worker.inputs(), unit, state, None, context)?.map(|inputs| {
                    (
                        Mode::Initial,
                        periodic_cause(state, &unit.id, worker_key, inputs_digest(&inputs)),
                    )
                })
            }
            CheckedWorker::Code {
                creates,
                every: None,
                ..
            } => {
                if creates
                    .iter()
                    .any(|artifact| latest(state, &unit.id, artifact).is_none())
                {
                    Some((Mode::Initial, Cause::Missing))
                } else {
                    None
                }
            }
        };
        if let Some((mode, cause)) = candidate {
            let cause = retry.unwrap_or(cause);
            wanted.push(Action::RunWorker {
                unit: unit.id.clone(),
                worker: worker_key.clone(),
                mode,
                cause,
            });
        }
    }
    Ok(wanted)
}
/// The operator reviews of a stage a decision is legal on now, each with its
/// inputs evaluated against the stepped state (an unresolved read as null).
fn resolve_reviews(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Vec<ResolvedReview>, StepError> {
    let mut resolved = Vec::new();
    for review in &checked_stage(program, unit)?.reviews {
        let CheckedReview::Operator {
            key,
            of,
            inputs,
            when,
            decisions,
        } = review
        else {
            continue;
        };
        if !holds(when.as_ref(), unit, state, context)? {
            continue;
        }
        let Some(target) = latest(state, &unit.id, of) else {
            continue;
        };
        if is_decided_by(state, &unit.id, key, &target.id) {
            continue;
        }
        let decisions = open_decisions(state, &unit.id, key, of, decisions);
        let mut resolved_inputs = serde_json::Map::new();
        for field in inputs {
            let value = eval_expression(&field.value.expression, unit, state, None, None, context)?;
            resolved_inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
        }
        resolved.push(ResolvedReview {
            unit: unit.id.clone(),
            review: key.clone(),
            target: target.id.clone(),
            decisions,
            inputs: Value::Object(resolved_inputs),
        });
    }
    Ok(resolved)
}
fn decided_artifact<'a>(of: &'a SymbolKey, on: &'a Option<SymbolKey>) -> &'a SymbolKey {
    on.as_ref().unwrap_or(of)
}
fn is_decided_by(
    state: &StepSnapshot,
    unit: &UnitId,
    review: &SymbolKey,
    target: &RevisionId,
) -> bool {
    state.decisions.iter().any(|decision| {
        decision.unit == *unit && decision.review == *review && decision.target == *target
    })
}
fn open_decisions(
    state: &StepSnapshot,
    unit: &UnitId,
    review: &SymbolKey,
    of: &SymbolKey,
    decisions: &BTreeMap<String, CheckedDecision>,
) -> Vec<ResolvedDecision> {
    decisions
        .iter()
        .filter_map(|(key, decision)| {
            let target = latest(state, unit, decided_artifact(of, &decision.on))?;
            (!is_decided_by(state, unit, review, &target.id)).then(|| ResolvedDecision {
                decision: SymbolKey::from(key.as_str()),
                target: target.id.clone(),
            })
        })
        .collect()
}
/// Evaluate what a wanted `RunWorker` runs with against the stepped state.
fn resolve_run_worker(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    action: &RunWorkerAction<'_>,
    context: &EvaluationContext<'_>,
) -> Result<ResolvedRunWorker, StepError> {
    let checked = checked_stage(program, unit)?
        .workers
        .iter()
        .find(|candidate| candidate.key() == action.worker)
        .ok_or_else(|| invalid(format!("checked worker {} absent", action.worker)))?;
    let mut inputs = serde_json::Map::new();
    for field in checked.inputs() {
        let value = eval_expression(&field.value.expression, unit, state, None, None, context)?;
        inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
    }
    let workspace_expression = match checked {
        CheckedWorker::Agent { workspace, .. } => workspace.as_ref(),
        CheckedWorker::Code { .. } => None,
    };
    let workspace = match workspace_expression {
        None => None,
        Some(expression) => Some(
            eval_expression(&expression.expression, unit, state, None, None, context)?
                .ok_or_else(|| invalid(format!("workspace of {} unresolved", action.worker)))?,
        ),
    };
    let (previous, feedback) = match action.mode {
        Mode::Revise => match answered_decision(state, &unit.id, checked.creates(), action.cause) {
            Some((revision, decision)) => (Some(revision.clone()), Some(decision.payload.clone())),
            None => (None, None),
        },
        _ => (None, None),
    };
    let subject = match (action.mode, checked) {
        (
            Mode::Review,
            CheckedWorker::Agent {
                reviews: Some(of), ..
            },
        ) => latest(state, &unit.id, of).cloned(),
        _ => None,
    };
    Ok(ResolvedRunWorker {
        action_id: action_id(&unit.id, action.worker, action.mode, action.cause),
        inputs: Value::Object(inputs),
        previous,
        feedback,
        subject,
        workspace,
    })
}
/// The request_changes decision a revise of `artifacts` answers: the
/// newest one on the latest revision of the first artifact, in `creates`
/// order, that has one.
fn changes_requested<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifacts: &[SymbolKey],
) -> Option<&'a DecisionState> {
    artifacts.iter().find_map(|artifact| {
        let latest = latest(state, unit, artifact)?;
        state.decisions.iter().rev().find(|decision| {
            decision.unit == *unit
                && decision.target == latest.id
                && decision.effect == DecisionEffect::RequestChanges
        })
    })
}
/// The decision a revise attempt answers, with the revision it requested
/// changes on: the one its cause names, or for a retry, which names none,
/// the one `changes_requested` picks as `stage_actions` did.
fn answered_decision<'a>(
    state: &'a StepSnapshot,
    unit: &UnitId,
    artifacts: &[SymbolKey],
    cause: &Cause,
) -> Option<(&'a RevisionState, &'a DecisionState)> {
    let decision = match cause {
        Cause::ChangesRequested { decision } => state
            .decisions
            .iter()
            .find(|candidate| candidate.id == *decision)?,
        _ => changes_requested(state, unit, artifacts)?,
    };
    let revision = state
        .revisions
        .iter()
        .find(|revision| revision.id == decision.target)?;
    Some((revision, decision))
}
struct RunWorkerAction<'a> {
    worker: &'a WorkerKey,
    mode: &'a Mode,
    cause: &'a Cause,
}
fn group_for<'a>(
    program: &'a CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
) -> Result<&'a CheckedGroup, StepError> {
    if unit.id == state.run.root {
        return Ok(&program.root);
    }
    let parent_id = unit
        .parent
        .as_ref()
        .ok_or_else(|| invalid("group has no parent"))?;
    let parent = state
        .units
        .iter()
        .find(|u| u.id == *parent_id)
        .ok_or_else(|| invalid("parent absent"))?;
    group_for(program, state, parent)?
        .units
        .iter()
        .find(|candidate| candidate.key.0 == unit.declaration.0)
        .and_then(|candidate| candidate.group.as_deref())
        .ok_or_else(|| invalid("checked group declaration absent"))
}
fn checked_unit<'a>(
    group: &'a CheckedGroup,
    declaration: &str,
) -> Result<&'a CheckedUnit, StepError> {
    group
        .units
        .iter()
        .find(|candidate| candidate.key.0 == declaration)
        .ok_or_else(|| invalid(format!("checked unit {declaration} absent")))
}
fn check_type(ty: &CheckedType, value: &Value) -> bool {
    match ty {
        CheckedType::Record { fields } => value.as_object().is_some_and(|object| {
            fields
                .iter()
                .all(|(key, ty)| object.get(key).is_some_and(|v| check_type(ty, v)))
        }),
        CheckedType::Text | CheckedType::RepoPath => value.is_string(),
        CheckedType::Ident => value.as_str().is_some_and(is_ident),
        CheckedType::Enumeration { variants } => value
            .as_str()
            .is_some_and(|text| variants.iter().any(|variant| variant == text)),
        CheckedType::Boolean => value.is_boolean(),
        CheckedType::Integer => value.is_i64(),
        CheckedType::Optional { value: inner } => value.is_null() || check_type(inner, value),
        CheckedType::List { item } => value
            .as_array()
            .is_some_and(|items| items.iter().all(|value| check_type(item, value))),
    }
}
/// The longest `ident`. Collection keys are idents taken from runtime data
/// and every id under a member embeds its key, so an unbounded ident would
/// make unbounded ids. 100 fits a GitHub repository or owner name, which
/// `pull_request.observe` carries as idents.
const MAX_IDENT_CHARS: usize = 100;
/// `hash(unit, worker, mode, cause)` (part 1 §4): 32 hex characters, so an
/// action's id is bounded however long its unit's path. The parts are
/// hashed as their wire JSON, which their schemas fix, not as Rust's
/// `Debug` output, which a refactor could change.
fn action_id(unit: &UnitId, worker: &WorkerKey, mode: &Mode, cause: &Cause) -> ActionKey {
    ActionKey(json_digest(&serde_json::json!([unit, worker, mode, cause])))
}
fn materialize_group(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    group_id: &UnitId,
    context: &EvaluationContext<'_>,
) -> Result<(), StepError> {
    let parent = state
        .units
        .iter()
        .find(|u| u.id == *group_id)
        .cloned()
        .ok_or_else(|| invalid("group absent"))?;
    let group = group_for(program, state, &parent)?.clone();
    let mut units = group.units.iter().collect::<Vec<_>>();
    units.sort_by_key(|unit| &unit.key);
    for unit in units {
        let key = &unit.key.0;
        let collection = unit.collection.clone();
        let each_values = if let Some(collection) = &collection {
            eval_expression(
                &collection.source.expression,
                &parent,
                state,
                None,
                None,
                context,
            )?
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(|| rejected(format!("collection {key} source is not a list")))?
        } else {
            vec![Value::Null]
        };
        if each_values.len() > context.limits.max_list_items {
            return Err(rejected("max_list_items exceeded"));
        }
        let mut keys = BTreeSet::new();
        for each in &each_values {
            let member = if let Some(collection) = &collection {
                eval_expression(
                    &collection.key.expression,
                    &parent,
                    state,
                    Some(each),
                    None,
                    context,
                )?
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or_else(|| rejected(format!("collection {key} key is not text")))?
            } else {
                key.clone()
            };
            if !is_ident(&member) || !keys.insert(member.clone()) {
                return Err(rejected(format!(
                    "collection {key} has illegal or duplicate key"
                )));
            }
            let dependencies = match &unit.after {
                CheckedUnitDependencies::None => vec![],
                CheckedUnitDependencies::Fixed { keys: items } => {
                    items.iter().map(|v| v.0.clone()).collect()
                }
                CheckedUnitDependencies::Each => {
                    let after = collection
                        .as_ref()
                        .ok_or_else(|| invalid("each prerequisites outside a collection"))?;
                    eval_expression(
                        &after.after.expression,
                        &parent,
                        state,
                        Some(each),
                        None,
                        context,
                    )?
                    .and_then(|v| v.as_array().cloned())
                    .ok_or_else(|| rejected(format!("collection {key} after is not a list")))?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| rejected("prerequisite key is not text"))
                    })
                    .collect::<Result<Vec<_>, _>>()?
                }
            };
            let declared_input = &unit.input;
            let input = if unit.collection.is_some() {
                eval_fields(declared_input, &parent, state, Some(each), context)?
                    .ok_or_else(|| rejected("collection input unresolved"))?
            } else {
                Value::Null
            };
            state.units.push(UnitState {
                id: UnitId(format!("{group_id}/{member}")),
                parent: Some(group_id.clone()),
                declaration: SymbolKey::from(key.as_str()),
                stage: unit.stage.clone(),
                status: UnitStatus::NotStarted,
                input,
                after: dependencies
                    .into_iter()
                    .map(|d| UnitId(format!("{group_id}/{d}")))
                    .collect(),
                pool: unit.pool.clone(),
            });
        }
    }
    let prerequisites: BTreeMap<&UnitId, BTreeSet<&UnitId>> = state
        .units
        .iter()
        .filter(|u| u.parent.as_ref() == Some(group_id))
        .map(|u| (&u.id, u.after.iter().collect()))
        .collect();
    if prerequisites
        .values()
        .flatten()
        .any(|d| !prerequisites.contains_key(d))
    {
        return Err(rejected("prerequisite references missing member"));
    }
    if !is_acyclic(&prerequisites) {
        return Err(rejected("cyclic prerequisite"));
    }
    Ok(())
}
fn group_outcome(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<Value, StepError> {
    eval_fields(
        &group_for(program, state, unit)?.outcome,
        unit,
        state,
        None,
        context,
    )?
    .ok_or_else(|| invalid("group outcome unresolved"))
}
/// Materialize an active group's members. A group with none (a collection
/// over an empty list) is done at once: this is the one step that holds
/// all of its members, since a snapshot omits a non-ancestor's children.
fn start_group(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    group_id: &UnitId,
    context: &EvaluationContext<'_>,
) -> Result<(), StepError> {
    materialize_group(program, state, group_id, context)?;
    if state
        .units
        .iter()
        .any(|unit| unit.parent.as_ref() == Some(group_id))
    {
        return Ok(());
    }
    let index = state
        .units
        .iter()
        .position(|unit| unit.id == *group_id)
        .ok_or_else(|| invalid("group absent"))?;
    let outcome = group_outcome(program, state, &state.units[index], context)?;
    state.units[index].status = UnitStatus::Done { outcome };
    Ok(())
}
fn reduce(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    incoming: &Incoming,
    context: &EvaluationContext<'_>,
) -> Result<(), StepError> {
    match &incoming.event {
        Event::Launched { input } => {
            if state.run.input.is_some() {
                return Ok(());
            }
            context.check_value(input)?;
            if !check_type(&program.input, input) {
                return Err(rejected("launch input fails schema"));
            }
            state.run.input = Some(input.clone());
            state.run.status = UnitStatus::Active;
            state.units.push(UnitState {
                id: state.run.root.clone(),
                parent: None,
                declaration: SymbolKey::from("$root"),
                stage: None,
                status: UnitStatus::Active,
                input: input.clone(),
                after: vec![],
                pool: None,
            });
            let root = state.run.root.clone();
            start_group(program, state, &root, context)?;
        }
        Event::WorkerStarted {
            action,
            kbbl_session_id,
        } => {
            let index = state
                .attempts
                .iter()
                .rposition(|a| a.action_id == *action)
                .ok_or_else(|| rejected("action absent"))?;
            let old = state.attempts[index].clone();
            match old.status {
                AttemptStatus::Pending => {
                    state.attempts[index].status = AttemptStatus::Running;
                    state.attempts[index].kbbl_session_id = kbbl_session_id.clone();
                }
                AttemptStatus::Running => {}
                AttemptStatus::Succeeded if matches!(old.cause, Cause::Periodic { .. }) => {
                    // A watch whose worker has moved on to another action
                    // (new inputs, or a retry) runs no further attempt.
                    if attempt(state, &old.unit, &old.worker)
                        .is_some_and(|latest| latest.action_id != *action)
                    {
                        return Err(rejected("periodic action is superseded"));
                    }
                    state.attempts.push(AttemptState {
                        seq: old.seq + 1,
                        status: AttemptStatus::Running,
                        kbbl_session_id: kbbl_session_id.clone(),
                        ended_at: None,
                        ..old
                    });
                }
                _ => {}
            }
        }
        Event::WorkerEnded { action, result } => {
            let index = state
                .attempts
                .iter()
                .rposition(|a| a.action_id == *action)
                .ok_or_else(|| rejected("action absent"))?;
            if matches!(
                state.attempts[index].status,
                AttemptStatus::Succeeded | AttemptStatus::Failed { .. }
            ) {
                return Ok(());
            }
            let attempt = state.attempts[index].clone();
            let unit = state
                .units
                .iter()
                .find(|u| u.id == attempt.unit)
                .ok_or_else(|| invalid("attempt unit absent"))?;
            let definition = worker(checked_stage(program, unit)?, &attempt.worker)?;
            state.attempts[index].status = match result {
                WorkerResult::Failed { code, detail } => AttemptStatus::Failed {
                    code: code.clone(),
                    detail: detail.clone(),
                },
                // A periodic worker publishes only a changed value, so an
                // unchanged observation is a success, whatever caused the attempt.
                WorkerResult::Succeeded
                    if !is_periodic(definition)
                        && definition.creates().iter().any(|artifact| {
                            !state.revisions.iter().any(|r| {
                                r.by.as_ref() == Some(&attempt.action_id) && r.artifact == *artifact
                            })
                        }) =>
                {
                    AttemptStatus::Failed {
                        code: "no_output".into(),
                        detail: "worker ended before publishing every artifact".into(),
                    }
                }
                WorkerResult::Succeeded => AttemptStatus::Succeeded,
            };
            state.attempts[index].ended_at = Some(attempt.seq as i64);
        }
        Event::RevisionPublished {
            unit,
            artifact,
            body,
            predecessor,
            subject,
            by,
        } => {
            context.check_value(body)?;
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let definition = checked_stage(program, owner)?.clone();
            let artifact_definition = definition
                .artifacts
                .iter()
                .find(|candidate| candidate.key == *artifact)
                .ok_or_else(|| rejected("artifact absent"))?;
            if !check_type(&artifact_definition.schema, body) {
                return Err(rejected("artifact body fails schema"));
            }
            // A revision is its body and what it reviews: the same body about a
            // new subject (a reviewer repeating itself on a new revision) is new.
            let is_unchanged =
                |revision: &RevisionState| revision.body == *body && revision.subject == *subject;
            // An operator's edit (D2) names no attempt; every other
            // revision names the attempt that published it.
            let is_operator = matches!(incoming.writer, Writer::Operator { .. });
            if is_operator != by.is_none() {
                return Err(rejected(if is_operator {
                    "an operator's revision names no attempt"
                } else {
                    "a revision that names no attempt must be the operator's"
                }));
            }
            if latest(state, unit, artifact)
                .is_some_and(|revision| revision.by == *by && is_unchanged(revision))
            {
                return Ok(());
            }
            let attempt_index = match by {
                None => None,
                Some(by) => Some(
                    state
                        .attempts
                        .iter()
                        .rposition(|a| {
                            a.action_id == *by
                                && a.unit == *unit
                                && matches!(
                                    a.status,
                                    AttemptStatus::Pending | AttemptStatus::Running
                                )
                        })
                        .ok_or_else(|| rejected("publication attempt is not current"))?,
                ),
            };
            let producer = match attempt_index {
                Some(index) => {
                    let producer = worker(&definition, &state.attempts[index].worker)?;
                    if !producer.creates().contains(artifact) {
                        return Err(rejected("worker does not create artifact"));
                    }
                    producer
                }
                None => definition
                    .workers
                    .iter()
                    .find(|candidate| candidate.creates().contains(artifact))
                    .ok_or_else(|| invalid("artifact has no creator"))?,
            };
            let is_code = matches!(producer, CheckedWorker::Code { .. });
            if is_code && by.is_none() {
                return Err(rejected("an operator cannot edit a code worker's artifact"));
            }
            // An unchanged value from a code worker (a periodic observation)
            // or an operator publishes nothing. An agent's attempt that
            // republishes it records a revision: the attempt published it.
            let previous = latest(state, unit, artifact);
            if previous.is_some_and(is_unchanged) && (is_code || by.is_none()) {
                return Ok(());
            }
            if previous.map(|r| &r.id) != predecessor.as_ref() {
                return Err(rejected("stale predecessor"));
            }
            let mut messages = Vec::new();
            for validation in &artifact_definition.validations {
                if eval_expression(
                    &validation.expression.expression,
                    owner,
                    state,
                    None,
                    Some((&artifact.0, body)),
                    context,
                )? != Some(Value::Bool(true))
                {
                    messages.push(validation.message.clone());
                }
            }
            if let (false, true, Some(attempt_index)) =
                (messages.is_empty(), is_code, attempt_index)
            {
                let attempt = state.attempts[attempt_index].clone();
                state.attempts[attempt_index].status = AttemptStatus::Failed {
                    code: "validation_failed".into(),
                    detail: messages.join("; "),
                };
                state.attempts[attempt_index].ended_at = Some(attempt.seq as i64);
                return Ok(());
            }
            let id = revision_id(state, unit, artifact);
            state.revisions.push(RevisionState {
                id: id.clone(),
                unit: unit.clone(),
                artifact: artifact.clone(),
                body: body.clone(),
                predecessor: predecessor.clone(),
                subject: subject.clone(),
                by: by.clone(),
            });
            if !messages.is_empty() && !is_code {
                let decision = decision_id(state, unit);
                state.decisions.push(DecisionState {
                    id: decision,
                    unit: unit.clone(),
                    review: SymbolKey::from("engine:validator"),
                    decision: SymbolKey::from("request_changes"),
                    effect: DecisionEffect::RequestChanges,
                    target: id,
                    payload: serde_json::json!({"feedback": messages.join("; ")}),
                });
            }
        }
        Event::OperatorDecided {
            unit,
            review,
            decision,
            target,
            payload,
        } => {
            context.check_value(payload)?;
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let review_definition = checked_stage(program, owner)?
                .reviews
                .iter()
                .find(|candidate| candidate.key() == review)
                .ok_or_else(|| rejected("review absent"))?;
            let (of, when, decisions) = match review_definition {
                CheckedReview::Operator {
                    of,
                    when,
                    decisions,
                    ..
                } => (of, when, decisions),
                CheckedReview::Engine {
                    decision: engine_decision,
                    ..
                } => {
                    if engine_decision.key != *decision {
                        return Err(rejected("decision absent"));
                    }
                    return Err(rejected("the engine decides this review"));
                }
            };
            let decision_definition = decisions
                .get(&decision.0)
                .ok_or_else(|| rejected("decision absent"))?;
            if !holds(when.as_ref(), owner, state, context)? {
                return Err(rejected("review is not open"));
            }
            if state.decisions.iter().any(|d| {
                d.unit == *unit
                    && d.review == *review
                    && d.decision == *decision
                    && d.target == *target
                    && d.payload == *payload
            }) {
                return Ok(());
            }
            let current = latest(state, unit, decided_artifact(of, &decision_definition.on))
                .ok_or_else(|| rejected("reviewed artifact unpublished"))?;
            if current.id != *target {
                return Err(rejected("target is not latest revision"));
            }
            if is_decided_by(state, unit, review, target) {
                return Err(rejected("review already decided on latest revision"));
            }
            if let Some(ty) = &decision_definition.payload {
                if !check_type(ty, payload) {
                    return Err(rejected("decision payload fails schema"));
                }
            }
            if decision_definition.effect == DecisionEffect::RequestChanges
                && payload
                    .get("feedback")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return Err(rejected("request_changes requires feedback"));
            }
            let id = decision_id(state, unit);
            state.decisions.push(DecisionState {
                id,
                unit: unit.clone(),
                review: review.clone(),
                decision: decision.clone(),
                effect: decision_definition.effect.clone(),
                target: target.clone(),
                payload: payload.clone(),
            });
        }
        Event::RetryRequested { unit, worker } => {
            // Only a replay of a retry already registered is a no-op: the
            // run layer stores every accepted retry request as a retry, so
            // a distinct request either registers one or is rejected.
            if state.retry_events.iter().any(|(u, w, id)| {
                u == unit && w == worker && incoming.ingress_id.as_deref() == Some(&id.0)
            }) {
                return Ok(());
            }
            let owner = state
                .units
                .iter()
                .find(|u| u.id == *unit)
                .ok_or_else(|| rejected("unit absent"))?;
            if !matches!(owner.status, UnitStatus::Active) {
                return Err(rejected("unit is not active"));
            }
            let previous =
                attempt(state, unit, worker).ok_or_else(|| rejected("worker has no attempt"))?;
            if !matches!(previous.status, AttemptStatus::Failed { .. }) {
                return Err(rejected("latest attempt has not failed"));
            }
            if latest_retry(state, unit, worker)
                .is_some_and(|last| !is_retry_spent(state, unit, worker, last))
            {
                return Err(rejected("a retry is already requested"));
            }
            // The ingress id is the retry's identity in every later
            // snapshot, so a retry without one could not be recognized.
            let id = EventId(
                incoming
                    .ingress_id
                    .clone()
                    .ok_or_else(|| rejected("a retry request needs an ingress id"))?,
            );
            state.retry_events.push((unit.clone(), worker.clone(), id));
        }
        Event::CancelRequested => {
            // A finished run stays finished; a cancelled one is cancelled once.
            match state.run.status {
                UnitStatus::Done { .. } => return Err(rejected("run is done")),
                UnitStatus::Cancelled => return Ok(()),
                _ => {}
            }
            for unit in &mut state.units {
                if !matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled) {
                    unit.status = UnitStatus::Cancelled;
                }
            }
            state.run.status = UnitStatus::Cancelled;
        }
    }
    Ok(())
}
/// The first engine review of an active stage whose guard holds and
/// that has not yet decided on its target's latest revision, decided:
/// once per target revision, with the review's fixed feedback.
fn engine_decision(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    unobserved: &[SymbolKey],
    context: &EvaluationContext<'_>,
) -> Result<Option<DecisionState>, StepError> {
    let definition = checked_stage(program, unit)?;
    for review in &definition.reviews {
        let CheckedReview::Engine {
            key,
            of,
            when,
            decision,
        } = review
        else {
            continue;
        };
        let target_artifact = decided_artifact(of, &decision.on);
        let Some(target) = latest(state, &unit.id, target_artifact) else {
            continue;
        };
        if is_creator_working(definition, state, &unit.id, target_artifact) {
            continue;
        }
        if reads_any(&when.expression, unobserved) {
            continue;
        }
        if is_decided_by(state, &unit.id, key, &target.id)
            || !holds(Some(when), unit, state, context)?
        {
            continue;
        }
        return Ok(Some(DecisionState {
            id: decision_id(state, &unit.id),
            unit: unit.id.clone(),
            review: key.clone(),
            decision: decision.key.clone(),
            effect: decision.effect.clone(),
            target: target.id.clone(),
            payload: serde_json::json!({ "feedback": decision.feedback }),
        }));
    }
    Ok(None)
}
/// One move of an active unit: a stage completes or its engine review
/// decides; a group whose members are all done completes.
fn advance_active(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    index: usize,
    context: &EvaluationContext<'_>,
) -> Result<bool, StepError> {
    let unit = state.units[index].clone();
    if unit.stage.is_some() {
        let definition = checked_stage(program, &unit)?;
        let unobserved = unobserved_watch_artifacts(program, state, &unit, context)?;
        // A stage completes on what its watches observe of their current inputs.
        let reads_unobserved = reads_any(&definition.done_when.expression, &unobserved)
            || definition
                .outcome
                .iter()
                .any(|field| reads_any(&field.value.expression, &unobserved));
        if !reads_unobserved
            && eval_expression(
                &definition.done_when.expression,
                &unit,
                state,
                None,
                None,
                context,
            )? == Some(Value::Bool(true))
        {
            let outcome = eval_fields(&definition.outcome, &unit, state, None, context)?
                .ok_or_else(|| invalid("stage outcome unresolved"))?;
            state.units[index].status = UnitStatus::Done { outcome };
            return Ok(true);
        }
        if let Some(decision) = engine_decision(program, state, &unit, &unobserved, context)? {
            state.decisions.push(decision);
            return Ok(true);
        }
        return Ok(false);
    }
    let children: Vec<_> = state
        .units
        .iter()
        .filter(|u| u.parent.as_ref() == Some(&unit.id))
        .collect();
    // An empty group completed when it materialized: no children here
    // means a snapshot that omits them, not a group that has none.
    if !children.is_empty()
        && children
            .iter()
            .all(|u| matches!(u.status, UnitStatus::Done { .. }))
    {
        let outcome = group_outcome(program, state, &unit, context)?;
        state.units[index].status = UnitStatus::Done { outcome };
        return Ok(true);
    }
    Ok(false)
}
fn advance(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    context: &EvaluationContext<'_>,
) -> Result<bool, StepError> {
    for index in 0..state.units.len() {
        if !matches!(state.units[index].status, UnitStatus::Active) {
            continue;
        }
        let unit_id = state.units[index].id.clone();
        if advance_active(program, state, index, context).map_err(advancing(&unit_id))? {
            return Ok(true);
        }
    }
    let mut candidates: Vec<_> = state
        .units
        .iter()
        .enumerate()
        .filter(|(_, u)| {
            matches!(
                u.status,
                UnitStatus::NotStarted | UnitStatus::Blocked { .. }
            )
        })
        .map(|(i, _)| i)
        .collect();
    candidates.sort_by_key(|&index| state.units[index].id.clone());
    for index in candidates {
        let unit_id = state.units[index].id.clone();
        if start_candidate(program, state, index, context).map_err(advancing(&unit_id))? {
            return Ok(true);
        }
    }
    Ok(false)
}
/// Start a unit that is not started or blocked, once what it waits on is
/// done and its pool has room; otherwise record why it is blocked.
fn start_candidate(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    index: usize,
    context: &EvaluationContext<'_>,
) -> Result<bool, StepError> {
    {
        let unit = state.units[index].clone();
        let waiting: Vec<_> = unit
            .after
            .iter()
            .filter(|dep| {
                !state
                    .units
                    .iter()
                    .any(|u| u.id == **dep && matches!(u.status, UnitStatus::Done { .. }))
            })
            .cloned()
            .collect();
        if !waiting.is_empty() {
            state.units[index].status = UnitStatus::Blocked {
                reason: BlockedReason::WaitingOn { units: waiting },
            };
            return Ok(false);
        }
        if let Some(pool) = &unit.pool {
            let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("pooled root"))?;
            let parent = state
                .units
                .iter()
                .find(|u| u.id == *parent_id)
                .ok_or_else(|| invalid("pool owner absent"))?;
            let capacity = *group_for(program, state, parent)?
                .pools
                .get(&pool.0)
                .ok_or_else(|| invalid("pool absent"))? as usize;
            let held = state
                .units
                .iter()
                .filter(|u| {
                    u.parent.as_ref() == Some(parent_id)
                        && u.pool.as_ref() == Some(pool)
                        && matches!(u.status, UnitStatus::Active)
                })
                .count();
            if held >= capacity {
                state.units[index].status = UnitStatus::Blocked {
                    reason: BlockedReason::Capacity { pool: pool.clone() },
                };
                return Ok(false);
            }
        }
        if unit.input.is_null() {
            let parent = state
                .units
                .iter()
                .find(|u| Some(&u.id) == unit.parent.as_ref())
                .ok_or_else(|| invalid("parent absent"))?;
            let declared = checked_unit(group_for(program, state, parent)?, &unit.declaration.0)?;
            state.units[index].input = eval_fields(&declared.input, parent, state, None, context)?
                .ok_or_else(|| invalid("unit input unresolved"))?;
        }
        state.units[index].status = UnitStatus::Active;
        if unit.stage.is_none() {
            start_group(program, state, &unit.id, context)?;
        }
        Ok(true)
    }
}
/// Pure reducer and bounded fixpoint that starts and completes units. The snapshot carries
/// the affected unit, its ancestors, and the evidence required by those units.
pub fn step(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
) -> Result<StepResult, StepError> {
    step_with_limits(program, snapshot, incoming, &ResourceLimits::default())
}
pub fn step_with_limits(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    incoming: &Incoming,
    limits: &ResourceLimits,
) -> Result<StepResult, StepError> {
    let context = EvaluationContext::new(limits);
    if let Some(input) = &snapshot.run.input {
        context.check_value(input)?;
    }
    for unit in &snapshot.units {
        context.check_value(&unit.input)?;
        if let UnitStatus::Done { outcome } = &unit.status {
            context.check_value(outcome)?;
        }
    }
    for revision in &snapshot.revisions {
        context.check_value(&revision.body)?;
    }
    for decision in &snapshot.decisions {
        context.check_value(&decision.payload)?;
    }
    let mut state = snapshot.clone();
    reduce(program, &mut state, incoming, &context)?;
    match advance_reduced(program, state, &context) {
        // A launch that cannot advance never started: it is refused, as a
        // launch whose input fails, not a stall of a run that is going.
        Err(StepError::Stalled { reason, .. })
            if matches!(incoming.event, Event::Launched { .. }) =>
        {
            Err(StepError::Rejected { reason })
        }
        other => other,
    }
}
/// Everything after the event is applied: advance to a fixpoint, then
/// resolve what each active stage wants. Nothing here is the event's own
/// fault, so each error is attributed to the unit it was raised on.
fn advance_reduced(
    program: &CheckedWorkflow,
    mut state: StepSnapshot,
    context: &EvaluationContext<'_>,
) -> Result<StepResult, StepError> {
    if !matches!(state.run.status, UnitStatus::Cancelled) {
        while advance(program, &mut state, context)? {}
        if let Some(root) = state.units.iter().find(|u| u.id == state.run.root) {
            state.run.status = root.status.clone();
        }
    }
    let mut wanted = Vec::new();
    let mut resolved = Vec::new();
    let mut reviews = Vec::new();
    let active: Vec<_> = state
        .units
        .iter()
        .filter(|u| u.stage.is_some() && matches!(u.status, UnitStatus::Active))
        .cloned()
        .collect();
    for unit in active {
        let wants =
            stage_wants(program, &mut state, &unit, context).map_err(advancing(&unit.id))?;
        resolved.extend(wants.resolved);
        reviews.extend(wants.reviews);
        wanted.push((unit.id, wants.actions));
    }
    Ok(StepResult {
        snapshot: state,
        wanted,
        resolved,
        reviews,
    })
}
/// What one active stage wants after the step, each wanted worker with
/// what it runs with, and the operator reviews open on it.
struct StageWants {
    actions: Vec<Action>,
    resolved: Vec<ResolvedRunWorker>,
    reviews: Vec<ResolvedReview>,
}
/// A wanted worker with no attempt yet gets its pending one.
fn stage_wants(
    program: &CheckedWorkflow,
    state: &mut StepSnapshot,
    stage_unit: &UnitState,
    context: &EvaluationContext<'_>,
) -> Result<StageWants, StepError> {
    let actions = stage_actions(program, state, stage_unit, context)?;
    let mut resolved = Vec::new();
    for action in &actions {
        let Action::RunWorker {
            unit,
            worker,
            mode,
            cause,
        } = action;
        let id = action_id(unit, worker, mode, cause);
        resolved.push(resolve_run_worker(
            program,
            state,
            stage_unit,
            &RunWorkerAction {
                worker,
                mode,
                cause,
            },
            context,
        )?);
        if !state.attempts.iter().any(|a| a.action_id == id) {
            state.attempts.push(AttemptState {
                action_id: id,
                seq: 1,
                unit: unit.clone(),
                worker: worker.clone(),
                mode: mode.clone(),
                cause: cause.clone(),
                status: AttemptStatus::Pending,
                kbbl_session_id: None,
                ended_at: None,
            });
        }
    }
    let reviews = resolve_reviews(program, state, stage_unit, context)?;
    Ok(StageWants {
        actions,
        resolved,
        reviews,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use workflow_compiler::compile_workflow;
    fn program() -> CheckedWorkflow {
        let source: Workflow = serde_json::from_value(serde_json::json!({
                "workflow":"simple", "input":{}, "run":{"units":{"document":{"stage":"document","input":{}}},"outcome":{"draft":"document.outcome.draft"}},
                "stages":{"document":{"input":{},"artifacts":{"draft":{"schema":"text"}},"workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},"inputs":{},"creates":["draft"]}},"done_when":"approved(draft)","outcome":{"draft":"latest(draft)"}}}
            })).unwrap();
        // Compiled rather than hand-assembled: the engine reads the
        // checked stages, so a stub with empty stages is not a program.
        let prompts: BTreeMap<String, String> = [("write.md".to_owned(), String::new())]
            .into_iter()
            .collect();
        workflow_compiler::compile_workflow(&source, &[], &prompts).unwrap()
    }
    #[test]
    fn valid_graph_accepts_a_long_chain_and_refuses_it_closed_into_a_cycle() {
        let chain = |is_closed: bool| -> Vec<Value> {
            (0..10_000)
                .map(|index: usize| {
                    let previous = match index {
                        0 if is_closed => vec![format!("k{}", 9_999)],
                        0 => vec![],
                        _ => vec![format!("k{}", index - 1)],
                    };
                    serde_json::json!({ "id": format!("k{index}"), "after": previous })
                })
                .collect()
        };
        assert!(is_valid_graph(&chain(false), "id", "after"));
        assert!(!is_valid_graph(&chain(true), "id", "after"));
    }
    fn snapshot() -> StepSnapshot {
        StepSnapshot {
            run: RunState {
                id: "run".into(),
                root: UnitId::from("run"),
                status: UnitStatus::NotStarted,
                input: None,
            },
            units: vec![],
            attempts: vec![],
            revisions: vec![],
            decisions: vec![],
            retry_events: vec![],
        }
    }
    fn incoming(event: Event, id: &str) -> Incoming {
        Incoming {
            event,
            writer: Writer::Engine,
            ingress_id: Some(id.into()),
        }
    }
    fn sample(name: &str) -> CheckedWorkflow {
        let content = match name {
            "review-loop" => include_str!("../../../fixtures/bundles/review-loop.json"),
            "fan-out" => include_str!("../../../fixtures/bundles/fan-out.json"),
            _ => panic!("unknown sample"),
        };
        let source: Workflow = serde_json::from_str(content).unwrap();
        let prompts: BTreeMap<String, String> = [
            (
                "review-loop/write.md",
                include_str!("../../../../workflow-config/prompts/review-loop/write.md"),
            ),
            (
                "review-loop/revise.md",
                include_str!("../../../../workflow-config/prompts/review-loop/revise.md"),
            ),
            (
                "review-loop/critique.md",
                include_str!("../../../../workflow-config/prompts/review-loop/critique.md"),
            ),
            (
                "review-loop/editor.md",
                include_str!("../../../../workflow-config/prompts/review-loop/editor.md"),
            ),
            (
                "fan-out/item.md",
                include_str!("../../../../workflow-config/prompts/fan-out/item.md"),
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let operations = vec![CodeOperation {
            key: SymbolKey::from("repository.prepare"),
            version: 1,
            input_schema: TypeExpression::Record(
                [
                    (
                        "repository_path".into(),
                        TypeExpression::Name("repo_path".into()),
                    ),
                    (
                        "expected_head".into(),
                        TypeExpression::Name("optional(text)".into()),
                    ),
                ]
                .into(),
            ),
            output_schema: TypeExpression::Record(
                [
                    (
                        "repository_path".into(),
                        TypeExpression::Name("repo_path".into()),
                    ),
                    (
                        "push_remote_owner".into(),
                        TypeExpression::Name("ident".into()),
                    ),
                    ("head".into(), TypeExpression::Name("ident".into())),
                ]
                .into(),
            ),
            error_codes: vec![],
        }];
        compile_workflow(&source, &operations, &prompts).unwrap()
    }
    fn event(spec: &Value, state: &StepSnapshot) -> Event {
        let unit = spec["unit"].as_str().unwrap_or("");
        let worker = spec["worker"].as_str().unwrap_or("");
        let action = || {
            state
                .attempts
                .iter()
                .rev()
                .find(|a| a.unit.0 == unit && a.worker.0 == worker)
                .unwrap()
                .action_id
                .clone()
        };
        match spec["op"].as_str().unwrap() {
            "launch" => Event::Launched {
                input: spec["input"].clone(),
            },
            "started" => Event::WorkerStarted {
                action: action(),
                kbbl_session_id: Some(format!("session:{unit}:{worker}")),
            },
            "ended" => Event::WorkerEnded {
                action: action(),
                result: if spec["result"] == "succeeded" {
                    WorkerResult::Succeeded
                } else {
                    WorkerResult::Failed {
                        code: "failed".into(),
                        detail: "test failure".into(),
                    }
                },
            },
            "publish" => Event::RevisionPublished {
                unit: UnitId::from(unit),
                artifact: SymbolKey::from(spec["artifact"].as_str().unwrap()),
                body: spec["body"].clone(),
                predecessor: spec["predecessor"].as_str().map(RevisionId::from),
                subject: spec["subject"].as_str().map(RevisionId::from),
                by: Some(action()),
            },
            "decide" => Event::OperatorDecided {
                unit: UnitId::from(unit),
                review: SymbolKey::from(spec["review"].as_str().unwrap()),
                decision: SymbolKey::from(spec["decision"].as_str().unwrap()),
                target: RevisionId::from(spec["target"].as_str().unwrap()),
                payload: spec["payload"].clone(),
            },
            "retry" => Event::RetryRequested {
                unit: UnitId::from(unit),
                worker: WorkerKey::from(worker),
            },
            _ => panic!("unknown event"),
        }
    }
    fn status_name(status: &UnitStatus) -> &'static str {
        match status {
            UnitStatus::NotStarted => "not_started",
            UnitStatus::Active => "active",
            UnitStatus::Blocked { .. } => "blocked",
            UnitStatus::Done { .. } => "done",
            UnitStatus::Cancelled => "cancelled",
        }
    }
    fn status_rank(status: &UnitStatus) -> u8 {
        match status {
            UnitStatus::NotStarted | UnitStatus::Blocked { .. } => 0,
            UnitStatus::Active => 1,
            UnitStatus::Done { .. } | UnitStatus::Cancelled => 2,
        }
    }
    fn assert_never_regresses(before: &StepSnapshot, after: &StepSnapshot) {
        for old in &before.units {
            let current = after.units.iter().find(|unit| unit.id == old.id).unwrap();
            assert!(
                status_rank(&current.status) >= status_rank(&old.status),
                "{} regressed",
                old.id
            );
        }
    }
    fn assert_one_live_attempt_per_worker(state: &StepSnapshot) {
        let mut live = BTreeSet::new();
        for attempt in &state.attempts {
            if matches!(
                attempt.status,
                AttemptStatus::Pending | AttemptStatus::Running
            ) {
                assert!(
                    live.insert((attempt.unit.clone(), attempt.worker.clone())),
                    "two live attempts for {}:{}",
                    attempt.unit,
                    attempt.worker
                );
            }
        }
    }

    #[test]
    fn named_schemas_resolve_through_optional_lists_and_records() {
        let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"aliases", "input":{"items":"optional(titles)"},
            "schemas":{"title":"text","titles":"list(title)"},
            "run":{"units":{},"outcome":{}},"stages":{}
        }))
        .unwrap();
        let program = compile_workflow(&source, &[], &BTreeMap::new()).unwrap();
        assert!(check_type(
            &program.input,
            &serde_json::json!({"items": ["one"]})
        ));
        assert!(check_type(
            &program.input,
            &serde_json::json!({"items": null})
        ));
        assert!(!check_type(
            &program.input,
            &serde_json::json!({"items": [1]})
        ));
    }

    #[test]
    fn checked_artifact_and_decision_schemas_contain_resolved_types() {
        let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"aliases", "input":{},
            "schemas":{"title":"text","titles":"list(title)"},
            "run":{"units":{"write":{"stage":"write","input":{}}},"outcome":{}},
            "stages":{"write":{
                "input":{}, "artifacts":{"draft":{"schema":"titles"}},
                "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},
                    "inputs":{},"creates":["draft"]}},
                "reviews":{"editor":{"of":"draft","by":"operator","prompt":"review.md",
                    "decisions":{"approve":{"effect":"approve","label":"Approve",
                        "payload":"optional(titles)"}}}},
                "done_when":"approved(draft)","outcome":{}
            }}
        }))
        .unwrap();
        let prompts = BTreeMap::from([
            ("write.md".into(), String::new()),
            ("review.md".into(), String::new()),
        ]);
        let program = compile_workflow(&source, &[], &prompts).unwrap();
        let stage = &program.stages[0];
        assert_eq!(
            stage.artifacts[0].schema,
            CheckedType::List {
                item: Box::new(CheckedType::Text)
            }
        );
        let CheckedReview::Operator { decisions, .. } = &stage.reviews[0] else {
            panic!("review is operator")
        };
        assert_eq!(
            decisions["approve"].payload,
            Some(CheckedType::Optional {
                value: Box::new(CheckedType::List {
                    item: Box::new(CheckedType::Text)
                })
            })
        );
    }

    #[test]
    fn wrapped_record_aliases_preserve_field_names_in_checked_schemas() {
        let source: Workflow = serde_json::from_value(serde_json::json!({
            "workflow":"aliases", "input":{"items":"list(row)","maybe":"optional(row)"},
            "schemas":{"row":{"a,b":"text"}},
            "run":{"units":{"write":{"stage":"write","input":{}}},"outcome":{}},
            "stages":{"write":{
                "input":{}, "artifacts":{"draft":{"schema":"list(row)"}},
                "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},
                    "inputs":{},"creates":["draft"]}},
                "reviews":{"editor":{"of":"draft","by":"operator","prompt":"review.md",
                    "decisions":{"approve":{"effect":"approve","label":"Approve",
                        "payload":"optional(row)"}}}},
                "done_when":"approved(draft)","outcome":{}
            }}
        }))
        .unwrap();
        let prompts = BTreeMap::from([
            ("write.md".into(), String::new()),
            ("review.md".into(), String::new()),
        ]);
        let program = compile_workflow(&source, &[], &prompts).unwrap();
        let valid_row = serde_json::json!({"a,b":"ok"});
        let invalid_row = serde_json::json!({"b":"ok"});
        assert!(check_type(
            &program.input,
            &serde_json::json!({"items":[valid_row],"maybe":valid_row})
        ));
        assert!(!check_type(
            &program.input,
            &serde_json::json!({"items":[invalid_row],"maybe":null})
        ));
        let stage = &program.stages[0];
        assert!(check_type(
            &stage.artifacts[0].schema,
            &serde_json::json!([valid_row])
        ));
        assert!(!check_type(
            &stage.artifacts[0].schema,
            &serde_json::json!([invalid_row])
        ));
        let CheckedReview::Operator { decisions, .. } = &stage.reviews[0] else {
            panic!("review is operator")
        };
        let payload = decisions["approve"].payload.as_ref().unwrap();
        assert!(check_type(payload, &valid_row));
        assert!(!check_type(payload, &invalid_row));
    }

    #[test]
    fn host_limits_reject_large_inputs_and_exhausted_expression_budget() {
        let program = sample("fan-out");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let launch = incoming(event(&trace["rows"][0]["events"][0], &snapshot()), "launch");
        let mut limits = ResourceLimits {
            max_list_items: 3,
            ..ResourceLimits::default()
        };
        assert!(
            matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
                Err(StepError::Rejected { reason }) if reason == "max_list_items exceeded")
        );
        limits.max_list_items = 10_000;
        limits.evaluation_budget = 0;
        assert!(
            matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
                Err(StepError::Rejected { reason }) if reason == "evaluation_budget exceeded")
        );
        limits.evaluation_budget = 1_000_000;
        limits.max_depth = 1;
        assert!(
            matches!(step_with_limits(&program, &snapshot(), &launch, &limits),
                Err(StepError::Rejected { reason }) if reason == "max_depth exceeded")
        );
    }

    #[test]
    fn reviewer_needs_every_output_for_its_subject() {
        let mut program = sample("review-loop");
        let stage = program
            .stages
            .iter_mut()
            .find(|stage| stage.key.0 == "document")
            .unwrap();
        let CheckedWorker::Agent { creates, .. } = stage
            .workers
            .iter_mut()
            .find(|worker| worker.key().0 == "critic")
            .unwrap()
        else {
            panic!("critic is an agent")
        };
        creates.push(SymbolKey::from("summary"));
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap()[..=1].iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        state
            .attempts
            .retain(|attempt| attempt.worker.0 != "critic");
        state.revisions.push(RevisionState {
            id: RevisionId::from("run/document:critique:1"),
            unit: UnitId::from("run/document"),
            artifact: SymbolKey::from("critique"),
            body: serde_json::json!({"notes": []}),
            predecessor: None,
            subject: Some(RevisionId::from("run/document:draft:1")),
            by: Some(ActionKey::from("previous-review")),
        });
        let unit = state
            .units
            .iter()
            .find(|unit| unit.id.0 == "run/document")
            .unwrap();
        assert!(stage_actions(
            &program,
            &state,
            unit,
            &EvaluationContext::new(&ResourceLimits::default())
        )
        .unwrap()
        .iter()
        .any(|action| matches!(
            action, Action::RunWorker { worker, mode: Mode::Review, .. } if worker.0 == "critic"
        )));
    }

    #[test]
    fn a_review_repeating_its_body_about_a_new_subject_is_a_new_revision() {
        let program = sample("review-loop");
        let mut trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let first_critique = trace["rows"][2]["events"][0]["body"].clone();
        let rows = trace["rows"].as_array_mut().unwrap();
        for event in rows[7]["events"].as_array_mut().unwrap() {
            if event["artifact"] == "critique" {
                event["body"] = first_critique.clone();
            }
        }
        let mut state = snapshot();
        for (index, row) in rows.iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        let subjects: Vec<_> = state
            .revisions
            .iter()
            .filter(|revision| revision.artifact.0 == "critique")
            .map(|revision| revision.subject.as_ref().map(|id| id.0.as_str()))
            .collect();
        assert_eq!(
            subjects,
            [Some("run/document:draft:1"), Some("run/document:draft:3")]
        );
        assert!(matches!(state.run.status, UnitStatus::Done { .. }));
    }

    #[test]
    fn member_outcomes_are_projected_in_key_order() {
        let program = sample("fan-out");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap()[..=1].iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        for child in state
            .units
            .iter_mut()
            .filter(|unit| unit.parent.as_ref().is_some_and(|id| id.0 == "run/work"))
        {
            child.status = UnitStatus::Done {
                outcome: Value::String(child.id.0.clone()),
            };
        }
        state.units.reverse();
        let owner = state
            .units
            .iter()
            .find(|unit| unit.id.0 == "run/work")
            .unwrap();
        let expression = Expression::Reference {
            root: ReferenceRoot::MemberOutcomes {
                unit: SymbolKey::from("item"),
            },
            path: vec![],
        };
        assert_eq!(
            eval_expression(
                &expression,
                owner,
                &state,
                None,
                None,
                &EvaluationContext::new(&ResourceLimits::default())
            ),
            Ok(Some(serde_json::json!([
                "run/work/a",
                "run/work/b",
                "run/work/c",
                "run/work/d"
            ])))
        );
    }

    #[test]
    fn failed_code_validation_does_not_publish_a_revision() {
        let mut source: Workflow =
            serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json")).unwrap();
        source
            .stages
            .get_mut("prepare")
            .unwrap()
            .artifacts
            .get_mut("workspace")
            .unwrap()
            .validate
            .push(ValidationCheck {
                check: "false".into(),
                message: "invalid workspace".into(),
            });
        let original = sample("fan-out");
        let operations = [CodeOperation {
            key: SymbolKey::from("repository.prepare"),
            version: 1,
            input_schema: TypeExpression::Record(BTreeMap::from([
                (
                    "repository_path".into(),
                    TypeExpression::Name("repo_path".into()),
                ),
                (
                    "expected_head".into(),
                    TypeExpression::Name("optional(text)".into()),
                ),
            ])),
            output_schema: source.stages["prepare"].artifacts["workspace"]
                .schema
                .clone(),
            error_codes: vec![],
        }];
        let prompts = BTreeMap::from([("fan-out/item.md".into(), String::new())]);
        let program = compile_workflow(&source, &operations, &prompts).unwrap();
        assert_eq!(program.stages.len(), original.stages.len());
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let launch = &trace["rows"][0]["events"][0];
        let state = step(
            &program,
            &snapshot(),
            &incoming(event(launch, &snapshot()), "launch"),
        )
        .unwrap()
        .snapshot;
        let publication = event(&trace["rows"][1]["events"][0], &state);
        let result = step(&program, &state, &incoming(publication, "publish")).unwrap();
        assert!(result.snapshot.revisions.is_empty());
        assert!(matches!(
            result.snapshot.attempts[0].status,
            AttemptStatus::Failed { .. }
        ));
        assert!(matches!(
            result
                .snapshot
                .units
                .iter()
                .find(|unit| unit.id.0 == "run/prepare")
                .unwrap()
                .status,
            UnitStatus::Active
        ));
    }

    #[test]
    fn operator_decision_uses_its_declared_target_artifact() {
        let mut program = sample("review-loop");
        let stage = program
            .stages
            .iter_mut()
            .find(|stage| stage.key.0 == "document")
            .unwrap();
        let CheckedReview::Operator { decisions, .. } = stage
            .reviews
            .iter_mut()
            .find(|review| review.key().0 == "editor")
            .unwrap()
        else {
            panic!("editor is an operator review")
        };
        decisions.get_mut("approve").unwrap().on = Some(SymbolKey::from("critique"));
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap()[..=2].iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        let result = step(
            &program,
            &state,
            &incoming(
                Event::OperatorDecided {
                    unit: UnitId::from("run/document"),
                    review: SymbolKey::from("editor"),
                    decision: SymbolKey::from("approve"),
                    target: RevisionId::from("run/document:critique:1"),
                    payload: serde_json::json!({}),
                },
                "approve-critique",
            ),
        )
        .unwrap();
        assert_eq!(
            result.snapshot.decisions.last().unwrap().target.0,
            "run/document:critique:1"
        );
    }
    fn apply_row(
        program: &CheckedWorkflow,
        state: &StepSnapshot,
        row: &Value,
        row_number: usize,
    ) -> StepSnapshot {
        let mut state = state.clone();
        let before = state.attempts.len();
        for (index, spec) in row["events"].as_array().unwrap().iter().enumerate() {
            let incoming = incoming(event(spec, &state), &format!("{row_number}:{index}"));
            let next = step(program, &state, &incoming).unwrap().snapshot;
            assert_never_regresses(&state, &next);
            assert_one_live_attempt_per_worker(&next);
            state = next;
        }
        for (key, expected) in row["status"].as_object().unwrap() {
            let actual = if key == "run" {
                &state.run.status
            } else {
                &state.units.iter().find(|u| u.id.0 == *key).unwrap().status
            };
            assert_eq!(
                status_name(actual),
                expected.as_str().unwrap(),
                "row {row_number} {key}"
            );
        }
        if let Some(expected) = row.get("new_workers") {
            let actual: Vec<_> = state.attempts[before..]
                .iter()
                .map(|a| format!("{}:{}", a.unit.0, a.worker.0))
                .collect();
            let expected: Vec<_> = expected
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(actual, expected, "row {row_number} new workers");
        }
        state
    }
    /// Steps each event spec in order; returns the last step's result.
    fn step_specs(program: &CheckedWorkflow, state: &StepSnapshot, specs: &[Value]) -> StepResult {
        let mut state = state.clone();
        let mut last = None;
        for (index, spec) in specs.iter().enumerate() {
            let incoming = incoming(event(spec, &state), &format!("resolved:{index}"));
            let result = step(program, &state, &incoming).unwrap();
            state = result.snapshot.clone();
            last = Some(result);
        }
        last.unwrap()
    }
    fn resolved_for<'a>(result: &'a StepResult, worker: &str) -> &'a ResolvedRunWorker {
        let attempt = result
            .snapshot
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.worker.0 == worker)
            .unwrap();
        result
            .resolved
            .iter()
            .find(|resolved| resolved.action_id == attempt.action_id)
            .unwrap()
    }
    #[test]
    fn an_awaiting_review_resolves_its_inputs_and_a_decided_one_drops_out() {
        let program = sample("review-loop");
        let published = [
            serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                    "artifact":"draft","body":{"title":"First","body":"Long"}}),
        ];
        let awaiting = step_specs(&program, &snapshot(), &published);
        let [editor] = awaiting.reviews.as_slice() else {
            panic!("one review awaits: {:?}", awaiting.reviews)
        };
        assert_eq!(
            (
                editor.review.0.as_str(),
                editor.target.0.as_str(),
                &editor.inputs["topic"],
                &editor.inputs["draft"],
                &editor.inputs["critique"]
            ),
            (
                "editor",
                "run/document:draft:1",
                &serde_json::json!("Oakridge"),
                &serde_json::json!({"title":"First","body":"Long"}),
                &Value::Null
            )
        );
        let decided = step_specs(&program, &snapshot(), &[
                published.as_slice(),
                &[serde_json::json!({"op":"decide","unit":"run/document","review":"editor",
                    "decision":"request_changes","target":"run/document:draft:1","payload":{"feedback":"shorter"}})],
            ].concat());
        assert!(decided.reviews.is_empty());
    }

    #[test]
    fn an_action_id_is_a_fixed_length_hash_of_its_parts() {
        let short = action_id(
            &UnitId::from("run/document"),
            &WorkerKey::from("writer"),
            &Mode::Revise,
            &Cause::ChangesRequested {
                decision: DecisionId::from("run/document:d1"),
            },
        );
        let long_unit = UnitId::from(format!("run/work/{}", "k".repeat(400)).as_str());
        let long = action_id(
            &long_unit,
            &WorkerKey::from("writer"),
            &Mode::Initial,
            &Cause::Missing,
        );
        let again = action_id(
            &long_unit,
            &WorkerKey::from("writer"),
            &Mode::Initial,
            &Cause::Missing,
        );
        assert_eq!(
            (short.0.len(), long.0.len(), long == again, short == long),
            (32, 32, true, false)
        );
    }

    #[test]
    fn a_collection_key_longer_than_an_ident_is_refused_at_launch() {
        let program = sample("fan-out");
        let input = |key: String| {
            serde_json::json!({"repository":{"repository_path":"/tmp/repo","expected_head":null},
                "items":[{"key":key,"text":"t","after":[]}]})
        };
        let launch = |key: String| {
            step(
                &program,
                &snapshot(),
                &incoming(
                    event(
                        &serde_json::json!({"op":"launch","input":input(key)}),
                        &snapshot(),
                    ),
                    "launch",
                ),
            )
        };
        assert!(launch("k".repeat(MAX_IDENT_CHARS)).is_ok());
        assert!(matches!(
            launch("k".repeat(MAX_IDENT_CHARS + 1)),
            Err(StepError::Rejected { .. })
        ));
    }

    #[test]
    fn initial_worker_inputs_resolve_with_unpublished_reads_as_null() {
        let program = sample("review-loop");
        let result = step_specs(
            &program,
            &snapshot(),
            &[serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}})],
        );
        let writer = resolved_for(&result, "writer");
        assert_eq!(
            (
                &writer.inputs,
                &writer.previous,
                &writer.subject,
                &writer.workspace
            ),
            (
                &serde_json::json!({"topic":"Oakridge","critique":null}),
                &None,
                &None,
                &None
            )
        );
    }
    #[test]
    fn a_reviewer_waits_for_its_subjects_creator_to_end_its_attempt() {
        let program = sample("review-loop");
        let published = [
            serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
            serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                    "artifact":"draft","body":{"title":"First","body":"Long"}}),
        ];
        let wants_critic = |result: &StepResult| {
            result.wanted.iter().flat_map(|(_, actions)| actions).any(
                |action| matches!(action, Action::RunWorker { worker, .. } if worker.0 == "critic"),
            )
        };
        let writing = step_specs(&program, &snapshot(), &published);
        let ended = step_specs(
                &program,
                &snapshot(),
                &[
                    published.as_slice(),
                    &[serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"})],
                ]
                .concat(),
            );
        assert_eq!(
            (wants_critic(&writing), wants_critic(&ended)),
            (false, true)
        );
    }
    #[test]
    fn reviewer_receives_the_revision_it_reviews_as_subject() {
        let program = sample("review-loop");
        let result = step_specs(
            &program,
            &snapshot(),
            &[
                serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
                serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
                serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                        "artifact":"draft","body":{"title":"First","body":"Long"}}),
                serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
            ],
        );
        let subject = resolved_for(&result, "critic").subject.as_ref().unwrap();
        assert_eq!(
            (&subject.id.0, &subject.body),
            (
                &"run/document:draft:1".to_owned(),
                &serde_json::json!({"title":"First","body":"Long"})
            )
        );
    }
    #[test]
    fn revise_receives_the_requested_revision_and_decision_payload() {
        let program = sample("review-loop");
        let result = step_specs(
            &program,
            &snapshot(),
            &[
                serde_json::json!({"op":"launch","input":{"topic":"Oakridge"}}),
                serde_json::json!({"op":"started","unit":"run/document","worker":"writer"}),
                serde_json::json!({"op":"publish","unit":"run/document","worker":"writer",
                        "artifact":"draft","body":{"title":"First","body":"Long"}}),
                serde_json::json!({"op":"ended","unit":"run/document","worker":"writer","result":"succeeded"}),
                serde_json::json!({"op":"decide","unit":"run/document","review":"editor",
                        "decision":"request_changes","target":"run/document:draft:1","payload":{"feedback":"shorter"}}),
            ],
        );
        let writer = resolved_for(&result, "writer");
        assert_eq!(
            (
                writer
                    .previous
                    .as_ref()
                    .map(|revision| revision.id.0.as_str()),
                &writer.feedback
            ),
            (
                Some("run/document:draft:1"),
                &Some(serde_json::json!({"feedback":"shorter"}))
            )
        );
    }
    /// One writer creating `plan` then `build`, and an operator review of
    /// `plan` whose `fix_build` decides on `build` instead.
    fn plan_and_build_program() -> CheckedWorkflow {
        let source: Workflow = serde_json::from_value(serde_json::json!({
                "workflow":"plan_and_build", "input":{}, "run":{"units":{"work":{"stage":"work","input":{}}},"outcome":{}},
                "stages":{"work":{"input":{},"artifacts":{"plan":{"schema":"text"},"build":{"schema":"text"}},
                    "workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md","revise":"revise.md"},"inputs":{},"creates":["plan","build"]}},
                    "reviews":{"check":{"of":"plan","by":"operator","prompt":"check.md","decisions":{
                        "accept":{"effect":"approve","label":"Accept"},
                        "fix_plan":{"effect":"request_changes","label":"Fix plan","fields":{"feedback":"What?"}},
                        "fix_build":{"effect":"request_changes","on":"build","label":"Fix build","fields":{"feedback":"What?"}}}}},
                    "done_when":"approved(plan)","outcome":{}}}
            }))
            .unwrap();
        let prompts: BTreeMap<String, String> = ["write.md", "revise.md", "check.md"]
            .into_iter()
            .map(|path| (path.to_owned(), String::new()))
            .collect();
        compile_workflow(&source, &[], &prompts).unwrap()
    }
    fn plan_and_build_published() -> Vec<Value> {
        vec![
            serde_json::json!({"op":"launch","input":{}}),
            serde_json::json!({"op":"started","unit":"run/work","worker":"writer"}),
            serde_json::json!({"op":"publish","unit":"run/work","worker":"writer","artifact":"plan","body":"plan one"}),
            serde_json::json!({"op":"publish","unit":"run/work","worker":"writer","artifact":"build","body":"build one"}),
        ]
    }
    #[test]
    fn an_awaiting_review_advertises_each_decisions_own_target() {
        let program = plan_and_build_program();
        let awaiting = step_specs(&program, &snapshot(), &plan_and_build_published());
        let [check] = awaiting.reviews.as_slice() else {
            panic!("one review awaits: {:?}", awaiting.reviews)
        };
        let targets: Vec<_> = check
            .decisions
            .iter()
            .map(|decision| (decision.decision.0.as_str(), decision.target.0.as_str()))
            .collect();
        assert_eq!(
            targets,
            [
                ("accept", "run/work:plan:1"),
                ("fix_build", "run/work:build:1"),
                ("fix_plan", "run/work:plan:1")
            ]
        );
    }
    #[test]
    fn a_decision_on_its_advertised_target_is_accepted() {
        let program = plan_and_build_program();
        let awaiting = step_specs(&program, &snapshot(), &plan_and_build_published());
        let fix_build = awaiting.reviews[0]
            .decisions
            .iter()
            .find(|decision| decision.decision.0 == "fix_build")
            .unwrap();
        let result = step(
            &program,
            &awaiting.snapshot,
            &incoming(
                Event::OperatorDecided {
                    unit: UnitId::from("run/work"),
                    review: SymbolKey::from("check"),
                    decision: fix_build.decision.clone(),
                    target: fix_build.target.clone(),
                    payload: serde_json::json!({"feedback":"rebuild"}),
                },
                "fix-build",
            ),
        );
        assert!(result.is_ok(), "{result:?}");
    }
    #[test]
    fn a_decided_target_stops_advertising_its_decisions() {
        let program = plan_and_build_program();
        let decided = step_specs(&program, &snapshot(), &[
                plan_and_build_published().as_slice(),
                &[serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                    "decision":"fix_build","target":"run/work:build:1","payload":{"feedback":"rebuild"}})],
            ].concat());
        let advertised: Vec<_> = decided.reviews[0]
            .decisions
            .iter()
            .map(|decision| decision.decision.0.as_str())
            .collect();
        assert_eq!(advertised, ["accept", "fix_plan"]);
    }
    #[test]
    fn revise_answers_the_decision_its_cause_names_not_the_newest() {
        let program = plan_and_build_program();
        // Both requests land while the writer is still running, so its
        // revise is wanted only once both exist: pinned to the one on
        // `plan`, the first artifact it creates, though `build`'s is newer.
        let result = step_specs(&program, &snapshot(), &[
                plan_and_build_published().as_slice(),
                &[
                    serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                        "decision":"fix_plan","target":"run/work:plan:1","payload":{"feedback":"replan"}}),
                    serde_json::json!({"op":"decide","unit":"run/work","review":"check",
                        "decision":"fix_build","target":"run/work:build:1","payload":{"feedback":"rebuild"}}),
                    serde_json::json!({"op":"ended","unit":"run/work","worker":"writer","result":"succeeded"}),
                ],
            ].concat());
        let writer = resolved_for(&result, "writer");
        assert_eq!(
            (
                writer
                    .previous
                    .as_ref()
                    .map(|revision| revision.id.0.as_str()),
                &writer.feedback
            ),
            (
                Some("run/work:plan:1"),
                &Some(serde_json::json!({"feedback":"replan"}))
            )
        );
    }
    #[test]
    fn repository_workspace_resolves_from_the_stage_input() {
        let program = sample("fan-out");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let rows = trace["rows"].as_array().unwrap();
        // The workspace publication completes prepare and starts the items.
        let specs = [rows[0]["events"][0].clone(), rows[1]["events"][0].clone()];
        let result = step_specs(&program, &snapshot(), &specs);
        let item = resolved_for(&result, "worker");
        assert_eq!(
            item.workspace,
            Some(
                serde_json::json!({"repository_path":"/tmp/repo","push_remote_owner":"owner","head":"abc"})
            )
        );
    }
    #[test]
    fn revision_and_decision_ids_are_unique_across_units() {
        let program = sample("fan-out");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        let ids: BTreeSet<_> = state.revisions.iter().map(|r| r.id.0.clone()).collect();
        assert_eq!((ids.len() > 1, ids.len()), (true, state.revisions.len()));
    }
    #[test]
    fn sample_traces_replay_every_prefix_and_never_regress_unit_status() {
        for (name, trace) in [
            (
                "review-loop",
                include_str!("../../../fixtures/traces/review-loop.json"),
            ),
            (
                "fan-out",
                include_str!("../../../fixtures/traces/fan-out.json"),
            ),
        ] {
            let program = sample(name);
            let trace: Value = serde_json::from_str(trace).unwrap();
            let rows = trace["rows"].as_array().unwrap();
            let mut state = snapshot();
            for (index, row) in rows.iter().enumerate() {
                let before = state.clone();
                state = apply_row(&program, &state, row, index);
                assert_never_regresses(&before, &state);
                let mut replay = snapshot();
                for (prefix, row) in rows[..=index].iter().enumerate() {
                    replay = apply_row(&program, &replay, row, prefix);
                }
                assert_eq!(replay, state, "{name} prefix {index}");
            }
        }
    }
    #[test]
    fn every_event_kind_preserves_unit_status_order() {
        for (name, trace) in [
            (
                "review-loop",
                include_str!("../../../fixtures/traces/review-loop.json"),
            ),
            (
                "fan-out",
                include_str!("../../../fixtures/traces/fan-out.json"),
            ),
        ] {
            let program = sample(name);
            let trace: Value = serde_json::from_str(trace).unwrap();
            let mut state = snapshot();
            for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
                let action = state
                    .attempts
                    .last()
                    .map(|attempt| attempt.action_id.clone())
                    .unwrap_or_else(|| ActionKey::from("absent"));
                let unit = state
                    .units
                    .iter()
                    .find(|unit| unit.stage.is_some())
                    .map(|unit| unit.id.clone())
                    .unwrap_or_else(|| UnitId::from("absent"));
                // Keep this list exhaustive against Event's wire schema below.
                let candidates = [
                    Event::Launched {
                        input: serde_json::json!({"topic":"Oakridge"}),
                    },
                    Event::WorkerStarted {
                        action: action.clone(),
                        kbbl_session_id: None,
                    },
                    Event::WorkerEnded {
                        action: action.clone(),
                        result: WorkerResult::Succeeded,
                    },
                    Event::RevisionPublished {
                        unit: unit.clone(),
                        artifact: SymbolKey::from("draft"),
                        body: serde_json::json!({"title":"x","body":"x"}),
                        predecessor: None,
                        subject: None,
                        by: Some(action),
                    },
                    Event::OperatorDecided {
                        unit: unit.clone(),
                        review: SymbolKey::from("editor"),
                        decision: SymbolKey::from("approve"),
                        target: RevisionId::from("run/document:draft:1"),
                        payload: serde_json::json!({}),
                    },
                    Event::RetryRequested {
                        unit,
                        worker: WorkerKey::from("writer"),
                    },
                    Event::CancelRequested,
                ];
                assert_eq!(candidates.len(), 7);
                for (kind, candidate) in candidates.into_iter().enumerate() {
                    if let Ok(result) = step(
                        &program,
                        &state,
                        &incoming(candidate, &format!("probe:{name}:{index}:{kind}")),
                    ) {
                        assert_never_regresses(&state, &result.snapshot);
                        assert_one_live_attempt_per_worker(&result.snapshot);
                    }
                }
                state = apply_row(&program, &state, row, index);
            }
        }
    }
    #[test]
    fn fan_out_stall_variant_keeps_failed_attempt_and_held_slot() {
        let program = sample("fan-out");
        let variant: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out-stall.json"))
                .unwrap();
        let mut state = snapshot();
        for (index, row) in variant["rows"].as_array().unwrap().iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        for (key, expected) in variant["status"].as_object().unwrap() {
            let actual = if key == "run" {
                &state.run.status
            } else {
                &state.units.iter().find(|u| u.id.0 == *key).unwrap().status
            };
            assert_eq!(status_name(actual), expected.as_str().unwrap());
        }
        assert!(state
            .attempts
            .iter()
            .any(|a| a.unit.0 == "run/work/b" && matches!(a.status, AttemptStatus::Failed { .. })));
        assert!(!state.attempts.iter().any(|a| a.unit.0 == "run/work/d"));
    }
    #[test]
    fn failed_attempt_stalls_until_retry_and_duplicates_change_nothing() {
        let program = program();
        let launched = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap();
        assert_eq!(launched.wanted.len(), 1);
        let attempt = launched.snapshot.attempts[0].action_id.clone();
        let started = step(
            &program,
            &launched.snapshot,
            &incoming(
                Event::WorkerStarted {
                    action: attempt.clone(),
                    kbbl_session_id: Some("session".into()),
                },
                "start",
            ),
        )
        .unwrap();
        let ended = step(
            &program,
            &started.snapshot,
            &incoming(
                Event::WorkerEnded {
                    action: attempt.clone(),
                    result: WorkerResult::Failed {
                        code: "oops".into(),
                        detail: "failed".into(),
                    },
                },
                "end",
            ),
        )
        .unwrap();
        assert!(ended.wanted[0].1.is_empty());
        let duplicate = step(
            &program,
            &ended.snapshot,
            &incoming(
                Event::WorkerEnded {
                    action: attempt,
                    result: WorkerResult::Failed {
                        code: "oops".into(),
                        detail: "failed".into(),
                    },
                },
                "end",
            ),
        )
        .unwrap();
        assert_eq!(duplicate.snapshot, ended.snapshot);
        let retry = step(
            &program,
            &ended.snapshot,
            &incoming(
                Event::RetryRequested {
                    unit: UnitId::from("run/document"),
                    worker: WorkerKey::from("writer"),
                },
                "retry",
            ),
        )
        .unwrap();
        assert_eq!(retry.wanted[0].1.len(), 1);
        assert_eq!(retry.snapshot.attempts.len(), 2);
    }
    #[test]
    fn a_failed_retry_attempt_waits_for_another_retry() {
        let program = program();
        let mut state = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap()
        .snapshot;
        let fail = |state: &StepSnapshot, action: ActionKey, id: &str| {
            let started = step(
                &program,
                state,
                &incoming(
                    Event::WorkerStarted {
                        action: action.clone(),
                        kbbl_session_id: None,
                    },
                    &format!("{id}:start"),
                ),
            )
            .unwrap();
            step(
                &program,
                &started.snapshot,
                &incoming(
                    Event::WorkerEnded {
                        action,
                        result: WorkerResult::Failed {
                            code: "oops".into(),
                            detail: "failed".into(),
                        },
                    },
                    &format!("{id}:end"),
                ),
            )
            .unwrap()
        };
        state = fail(&state, state.attempts[0].action_id.clone(), "first").snapshot;
        state = step(
            &program,
            &state,
            &incoming(
                Event::RetryRequested {
                    unit: UnitId::from("run/document"),
                    worker: WorkerKey::from("writer"),
                },
                "retry",
            ),
        )
        .unwrap()
        .snapshot;
        let retried = state.attempts.last().unwrap().action_id.clone();
        let failed_again = fail(&state, retried, "second");
        assert!(failed_again
            .wanted
            .iter()
            .all(|(_, actions)| actions.is_empty()));
        assert_eq!(failed_again.snapshot.attempts.len(), 2);
    }
    #[test]
    fn a_retry_request_while_the_retry_attempt_is_live_is_rejected_and_registers_nothing() {
        let program = program();
        let launched = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap();
        let action = launched.snapshot.attempts[0].action_id.clone();
        let mut state = launched.snapshot;
        for (event, id) in [
            (
                Event::WorkerStarted {
                    action: action.clone(),
                    kbbl_session_id: None,
                },
                "start",
            ),
            (
                Event::WorkerEnded {
                    action,
                    result: WorkerResult::Failed {
                        code: "oops".into(),
                        detail: "failed".into(),
                    },
                },
                "end",
            ),
        ] {
            state = step(&program, &state, &incoming(event, id))
                .unwrap()
                .snapshot;
        }
        let retry = |id: &str| {
            incoming(
                Event::RetryRequested {
                    unit: UnitId::from("run/document"),
                    worker: WorkerKey::from("writer"),
                },
                id,
            )
        };
        let retried = step(&program, &state, &retry("retry-1")).unwrap().snapshot;
        let replayed = step(&program, &retried, &retry("retry-1"))
            .unwrap()
            .snapshot;
        assert_eq!(replayed, retried);
        assert!(step(&program, &retried, &retry("retry-2")).is_err());
    }
    #[test]
    fn a_retry_request_without_an_ingress_id_is_rejected() {
        let program = program();
        let launched = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap();
        let retry = Incoming {
            event: Event::RetryRequested {
                unit: UnitId::from("run/document"),
                worker: WorkerKey::from("writer"),
            },
            writer: Writer::Engine,
            ingress_id: None,
        };
        assert!(step(&program, &launched.snapshot, &retry).is_err());
    }
    #[test]
    fn periodic_worker_uses_one_action_id_and_three_distinct_attempt_sequences() {
        let source: Workflow = serde_json::from_value(serde_json::json!({
                "workflow":"periodic", "input":{}, "run":{"units":{"watch":{"stage":"watch","input":{}}},"outcome":{}},
                "stages":{"watch":{"input":{},"artifacts":{"observation":{"schema":"text"}},"workers":{"observer":{"kind":"code","operation":"observe","inputs":{},"creates":["observation"],"every":"1s"}},"done_when":"false","outcome":{}}}
            })).unwrap();
        let observe = vec![CodeOperation {
            key: SymbolKey::from("observe"),
            version: 1,
            input_schema: TypeExpression::Record(BTreeMap::new()),
            output_schema: TypeExpression::Name("text".into()),
            error_codes: vec![],
        }];
        let program =
            workflow_compiler::compile_workflow(&source, &observe, &BTreeMap::new()).unwrap();
        let launched = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap();
        let mut state = launched.snapshot;
        let action = state.attempts[0].action_id.clone();
        for tick in 1..=3 {
            state = step(
                &program,
                &state,
                &incoming(
                    Event::WorkerStarted {
                        action: action.clone(),
                        kbbl_session_id: None,
                    },
                    &format!("start:{tick}"),
                ),
            )
            .unwrap()
            .snapshot;
            state = step(
                &program,
                &state,
                &incoming(
                    Event::WorkerEnded {
                        action: action.clone(),
                        result: WorkerResult::Succeeded,
                    },
                    &format!("end:{tick}"),
                ),
            )
            .unwrap()
            .snapshot;
        }
        assert_eq!(
            state.attempts.iter().map(|a| a.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(state
            .attempts
            .iter()
            .all(|a| a.action_id == action && matches!(a.status, AttemptStatus::Succeeded)));
        assert_eq!(
            state
                .attempts
                .iter()
                .map(|a| a.ended_at)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
    }
    /// A builder agent publishing `pr`, and a watch observing `latest(pr)`
    /// every second once it is published: the shape of `pr_watch`.
    fn watch_program() -> CheckedWorkflow {
        let source: Workflow = serde_json::from_value(serde_json::json!({
                "workflow":"watch", "input":{}, "run":{"units":{"watch":{"stage":"watch","input":{}}},"outcome":{}},
                "stages":{"watch":{"input":{},"artifacts":{"pr":{"schema":"text"},"observation":{"schema":"text"}},
                  "workers":{"builder":{"kind":"agent","prompts":{"initial":"build.md"},"inputs":{},"creates":["pr"]},
                    "observer":{"kind":"code","operation":"observe","when":"published(pr)","inputs":{"branch":"latest(pr)"},"creates":["observation"],"every":"1s"}},
                  "done_when":"false","outcome":{}}}
            })).unwrap();
        let observe = vec![CodeOperation {
            key: SymbolKey::from("observe"),
            version: 1,
            input_schema: TypeExpression::Record(BTreeMap::from([(
                "branch".to_owned(),
                TypeExpression::Name("text".into()),
            )])),
            output_schema: TypeExpression::Name("text".into()),
            error_codes: vec![],
        }];
        let prompts = BTreeMap::from([("build.md".to_owned(), String::new())]);
        workflow_compiler::compile_workflow(&source, &observe, &prompts).unwrap()
    }
    fn latest_action(state: &StepSnapshot, worker: &str) -> ActionKey {
        state
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.worker.0 == worker)
            .unwrap()
            .action_id
            .clone()
    }
    fn run_attempt(
        program: &CheckedWorkflow,
        state: &StepSnapshot,
        action: &ActionKey,
        result: WorkerResult,
        id: &str,
    ) -> StepResult {
        let started = step(
            program,
            state,
            &incoming(
                Event::WorkerStarted {
                    action: action.clone(),
                    kbbl_session_id: None,
                },
                &format!("{id}:start"),
            ),
        )
        .unwrap();
        step(
            program,
            &started.snapshot,
            &incoming(
                Event::WorkerEnded {
                    action: action.clone(),
                    result,
                },
                &format!("{id}:end"),
            ),
        )
        .unwrap()
    }
    /// An operator's edit of `pr`: what moves the watch's input in these tests.
    fn edit_pr(program: &CheckedWorkflow, state: &StepSnapshot, branch: &str) -> StepResult {
        let unit = UnitId::from("run/watch");
        let predecessor = latest(state, &unit, &SymbolKey::from("pr")).map(|r| r.id.clone());
        step(
            program,
            state,
            &Incoming {
                event: Event::RevisionPublished {
                    unit,
                    artifact: SymbolKey::from("pr"),
                    body: serde_json::json!(branch),
                    predecessor,
                    subject: None,
                    by: None,
                },
                writer: Writer::Operator {
                    subject: OperatorId::from("operator"),
                },
                ingress_id: Some(format!("edit:{branch}")),
            },
        )
        .unwrap()
    }
    /// Launched, the builder's `pr` published as "one", and the first watch
    /// opened on it.
    fn watching_one(program: &CheckedWorkflow) -> StepSnapshot {
        let launched = step(
            program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap()
        .snapshot;
        let builder = latest_action(&launched, "builder");
        let started = step(
            program,
            &launched,
            &incoming(
                Event::WorkerStarted {
                    action: builder.clone(),
                    kbbl_session_id: None,
                },
                "builder:start",
            ),
        )
        .unwrap()
        .snapshot;
        let published = step(
            program,
            &started,
            &incoming(
                Event::RevisionPublished {
                    unit: UnitId::from("run/watch"),
                    artifact: SymbolKey::from("pr"),
                    body: serde_json::json!("one"),
                    predecessor: None,
                    subject: None,
                    by: Some(builder.clone()),
                },
                "builder:publish",
            ),
        )
        .unwrap()
        .snapshot;
        step(
            program,
            &published,
            &incoming(
                Event::WorkerEnded {
                    action: builder,
                    result: WorkerResult::Succeeded,
                },
                "builder:end",
            ),
        )
        .unwrap()
        .snapshot
    }
    #[test]
    fn a_watch_whose_inputs_change_is_replaced_by_one_pinned_to_the_new_inputs() {
        let program = watch_program();
        let state = watching_one(&program);
        let first = latest_action(&state, "observer");
        let state =
            run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
        let moved = edit_pr(&program, &state, "two");
        let second = latest_action(&moved.snapshot, "observer");
        assert_ne!(second, first);
        assert_eq!(
            resolved_for(&moved, "observer").inputs,
            serde_json::json!({"branch": "two"})
        );
        assert!(matches!(
            &moved.snapshot.attempts.last().unwrap().cause,
            Cause::Periodic { replaces: Some(replaced), .. } if *replaced == first
        ));
    }
    #[test]
    fn a_replaced_watch_starts_no_further_attempt() {
        let program = watch_program();
        let state = watching_one(&program);
        let first = latest_action(&state, "observer");
        let state =
            run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
        let moved = edit_pr(&program, &state, "two").snapshot;
        let late_start = step(
            &program,
            &moved,
            &incoming(
                Event::WorkerStarted {
                    action: first,
                    kbbl_session_id: None,
                },
                "first:late",
            ),
        );
        assert!(matches!(late_start, Err(StepError::Rejected { .. })));
    }
    #[test]
    fn a_watch_back_on_earlier_inputs_is_a_new_action() {
        let program = watch_program();
        let state = watching_one(&program);
        let first = latest_action(&state, "observer");
        let state =
            run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first").snapshot;
        let state = edit_pr(&program, &state, "two").snapshot;
        let second = latest_action(&state, "observer");
        let state =
            run_attempt(&program, &state, &second, WorkerResult::Succeeded, "second").snapshot;
        let back = edit_pr(&program, &state, "one");
        let third = latest_action(&back.snapshot, "observer");
        assert!(third != first && third != second);
        assert_eq!(
            resolved_for(&back, "observer").inputs,
            serde_json::json!({"branch": "one"})
        );
    }
    #[test]
    fn a_watch_on_unchanged_inputs_keeps_its_action() {
        let program = watch_program();
        let state = watching_one(&program);
        let first = latest_action(&state, "observer");
        let ended = run_attempt(&program, &state, &first, WorkerResult::Succeeded, "first");
        assert_eq!(
            ended
                .snapshot
                .attempts
                .iter()
                .filter(|a| a.worker.0 == "observer")
                .count(),
            1
        );
    }
    #[test]
    fn a_retried_watch_succeeds_on_an_unchanged_observation_and_resumes_its_schedule() {
        let program = watch_program();
        let state = watching_one(&program);
        let first = latest_action(&state, "observer");
        let state = run_attempt(
            &program,
            &state,
            &first,
            WorkerResult::Failed {
                code: "unavailable".into(),
                detail: "down".into(),
            },
            "first",
        )
        .snapshot;
        let state = step(
            &program,
            &state,
            &incoming(
                Event::RetryRequested {
                    unit: UnitId::from("run/watch"),
                    worker: WorkerKey::from("observer"),
                },
                "retry",
            ),
        )
        .unwrap()
        .snapshot;
        let retried = latest_action(&state, "observer");
        let ended = run_attempt(&program, &state, &retried, WorkerResult::Succeeded, "retry");
        let retry_attempt = ended
            .snapshot
            .attempts
            .iter()
            .find(|a| a.action_id == retried)
            .unwrap();
        assert_eq!(retry_attempt.status, AttemptStatus::Succeeded);
        let resumed = latest_action(&ended.snapshot, "observer");
        assert!(matches!(
            &ended.snapshot.attempts.last().unwrap().cause,
            Cause::Periodic { replaces: Some(replaced), .. } if *replaced == retried
        ));
        let state = run_attempt(
            &program,
            &ended.snapshot,
            &resumed,
            WorkerResult::Succeeded,
            "resumed:1",
        )
        .snapshot;
        let state = run_attempt(
            &program,
            &state,
            &resumed,
            WorkerResult::Succeeded,
            "resumed:2",
        )
        .snapshot;
        assert_eq!(
            state
                .attempts
                .iter()
                .filter(|a| a.action_id == resumed && a.status == AttemptStatus::Succeeded)
                .count(),
            2
        );
    }
    #[test]
    fn duplicate_event_vocabulary_keeps_the_snapshot_identical() {
        let program = sample("review-loop");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let rows = trace["rows"].as_array().unwrap();
        let launched = apply_row(&program, &snapshot(), &rows[0], 0);
        let launch = event(&rows[0]["events"][0], &launched);
        assert_eq!(
            step(&program, &launched, &incoming(launch, "0:0"))
                .unwrap()
                .snapshot,
            launched
        );
        let published = apply_row(&program, &launched, &rows[1], 1);
        let writer = published
            .attempts
            .iter()
            .find(|a| a.worker.0 == "writer")
            .unwrap()
            .action_id
            .clone();
        let started = Event::WorkerStarted {
            action: writer.clone(),
            kbbl_session_id: Some("session:run/document:writer".into()),
        };
        assert_eq!(
            step(&program, &published, &incoming(started, "1:0"))
                .unwrap()
                .snapshot,
            published
        );
        let publication = event(&rows[1]["events"][1], &published);
        assert_eq!(
            step(&program, &published, &incoming(publication, "1:1"))
                .unwrap()
                .snapshot,
            published
        );
        let settled = apply_row(&program, &published, &rows[2], 2);
        let ended = Event::WorkerEnded {
            action: writer,
            result: WorkerResult::Succeeded,
        };
        assert_eq!(
            step(&program, &settled, &incoming(ended, "2:2"))
                .unwrap()
                .snapshot,
            settled
        );
        let decided = apply_row(&program, &settled, &rows[3], 3);
        let decision = event(&rows[3]["events"][0], &decided);
        assert_eq!(
            step(&program, &decided, &incoming(decision, "3:0"))
                .unwrap()
                .snapshot,
            decided
        );
        let mut state = decided;
        for (index, row) in rows[4..=6].iter().enumerate() {
            state = apply_row(&program, &state, row, index + 4);
        }
        let retry = event(&rows[6]["events"][0], &state);
        assert_eq!(
            step(&program, &state, &incoming(retry, "6:0"))
                .unwrap()
                .snapshot,
            state
        );
    }
    #[test]
    fn stale_review_retry_and_publication_are_rejected() {
        let program = sample("review-loop");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let rows = trace["rows"].as_array().unwrap();
        let launched = apply_row(&program, &snapshot(), &rows[0], 0);
        assert!(matches!(
            step(
                &program,
                &launched,
                &incoming(
                    Event::RetryRequested {
                        unit: UnitId::from("run/document"),
                        worker: WorkerKey::from("writer")
                    },
                    "bad-retry"
                )
            ),
            Err(StepError::Rejected { .. })
        ));
        assert!(matches!(
            step(
                &program,
                &launched,
                &incoming(
                    Event::RevisionPublished {
                        unit: UnitId::from("run/document"),
                        artifact: SymbolKey::from("draft"),
                        body: serde_json::json!({"title":"x","body":"x"}),
                        predecessor: None,
                        subject: None,
                        by: Some(ActionKey::from("forged"))
                    },
                    "forged"
                )
            ),
            Err(StepError::Rejected { .. })
        ));
        let mut state = launched;
        for (index, row) in rows[..=4].iter().enumerate().skip(1) {
            state = apply_row(&program, &state, row, index);
        }
        assert!(matches!(
            step(
                &program,
                &state,
                &incoming(
                    Event::OperatorDecided {
                        unit: UnitId::from("run/document"),
                        review: SymbolKey::from("editor"),
                        decision: SymbolKey::from("approve"),
                        target: RevisionId::from("run/document:draft:1"),
                        payload: serde_json::json!({})
                    },
                    "stale"
                )
            ),
            Err(StepError::Rejected { .. })
        ));
    }
    /// Fan-out launched over `items`, then its workspace published: the
    /// step that starts the collection group.
    fn fan_out_preparing(items: Value) -> (CheckedWorkflow, StepSnapshot, Incoming) {
        let program = sample("fan-out");
        let input = serde_json::json!({"repository":{"repository_path":"/tmp/repo","expected_head":null},"items":items});
        let launched = step(
            &program,
            &snapshot(),
            &incoming(Event::Launched { input }, "launch"),
        )
        .unwrap()
        .snapshot;
        let git = launched.attempts[0].action_id.clone();
        let publish = Event::RevisionPublished {
            unit: UnitId::from("run/prepare"),
            artifact: SymbolKey::from("workspace"),
            body: serde_json::json!({"repository_path":"/tmp/repo","push_remote_owner":"owner","head":"abc"}),
            predecessor: None,
            subject: None,
            by: Some(git),
        };
        (program, launched, incoming(publish, "publish"))
    }
    #[test]
    fn a_collection_over_an_empty_list_completes_its_group_and_the_run() {
        let (program, launched, publish) = fan_out_preparing(serde_json::json!([]));
        let result = step(&program, &launched, &publish).unwrap();
        let work = result
            .snapshot
            .units
            .iter()
            .find(|unit| unit.id.0 == "run/work")
            .unwrap();
        assert_eq!(
            (&work.status, &result.snapshot.run.status),
            (
                &UnitStatus::Done {
                    outcome: serde_json::json!({"results": []})
                },
                &UnitStatus::Done {
                    outcome: serde_json::json!({"results": []})
                }
            )
        );
    }
    #[test]
    fn a_group_that_cannot_materialize_after_launch_stalls_at_that_group() {
        let item = serde_json::json!({"key":"same","text":"t","after":[]});
        let (program, launched, publish) =
            fan_out_preparing(serde_json::json!([item.clone(), item]));
        assert!(matches!(
            step(&program, &launched, &publish),
            Err(StepError::Stalled { unit, reason })
                if unit.0 == "run/work" && reason.contains("duplicate key")
        ));
    }
    #[test]
    fn an_inconsistency_found_advancing_another_unit_names_that_unit() {
        let (program, mut launched, publish) =
            fan_out_preparing(serde_json::json!([{"key":"a","text":"t","after":[]}]));
        let work = launched
            .units
            .iter_mut()
            .find(|unit| unit.id.0 == "run/work")
            .unwrap();
        work.stage = Some(SymbolKey::from("absent"));
        assert!(matches!(
            step(&program, &launched, &publish),
            Err(StepError::Invalid { unit: Some(unit), .. }) if unit.0 == "run/work"
        ));
    }
    /// The review-loop trace played to its end: the run is done.
    fn review_loop_done() -> (CheckedWorkflow, StepSnapshot) {
        let program = sample("review-loop");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/review-loop.json"))
                .unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap().iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        (program, state)
    }
    #[test]
    fn a_done_run_refuses_cancel() {
        let (program, done) = review_loop_done();
        assert!(matches!(
            step(&program, &done, &incoming(Event::CancelRequested, "cancel")),
            Err(StepError::Rejected { reason }) if reason == "run is done"
        ));
    }
    #[test]
    fn a_done_unit_refuses_a_decision() {
        let (program, done) = review_loop_done();
        let decision = Event::OperatorDecided {
            unit: UnitId::from("run/document"),
            review: SymbolKey::from("editor"),
            decision: SymbolKey::from("request_changes"),
            target: RevisionId::from("run/document:draft:3"),
            payload: serde_json::json!({"feedback": "again"}),
        };
        assert!(matches!(
            step(&program, &done, &incoming(decision, "late")),
            Err(StepError::Rejected { reason }) if reason == "unit is not active"
        ));
    }
    #[test]
    fn a_cancelled_unit_refuses_a_retry_of_its_failed_worker() {
        let program = program();
        let launched = step(
            &program,
            &snapshot(),
            &incoming(
                Event::Launched {
                    input: serde_json::json!({}),
                },
                "launch",
            ),
        )
        .unwrap()
        .snapshot;
        let writer = launched.attempts[0].action_id.clone();
        let failed = run_attempt(
            &program,
            &launched,
            &writer,
            WorkerResult::Failed {
                code: "oops".into(),
                detail: "failed".into(),
            },
            "writer",
        )
        .snapshot;
        let cancelled = step(
            &program,
            &failed,
            &incoming(Event::CancelRequested, "cancel"),
        )
        .unwrap()
        .snapshot;
        let retry = Event::RetryRequested {
            unit: UnitId::from("run/document"),
            worker: WorkerKey::from("writer"),
        };
        assert!(matches!(
            step(&program, &cancelled, &incoming(retry, "retry")),
            Err(StepError::Rejected { reason }) if reason == "unit is not active"
        ));
    }
    #[test]
    fn cancel_is_terminal_and_idempotent_across_the_group_tree() {
        let program = sample("fan-out");
        let trace: Value =
            serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json")).unwrap();
        let mut state = snapshot();
        for (index, row) in trace["rows"].as_array().unwrap()[..=2].iter().enumerate() {
            state = apply_row(&program, &state, row, index);
        }
        let cancelled = step(
            &program,
            &state,
            &incoming(Event::CancelRequested, "cancel"),
        )
        .unwrap();
        assert!(matches!(
            cancelled.snapshot.run.status,
            UnitStatus::Cancelled
        ));
        assert!(cancelled
            .snapshot
            .units
            .iter()
            .all(|unit| matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled)));
        assert!(cancelled.wanted.is_empty());
        let duplicate = step(
            &program,
            &cancelled.snapshot,
            &incoming(Event::CancelRequested, "cancel"),
        )
        .unwrap();
        assert_eq!(duplicate.snapshot, cancelled.snapshot);
    }
}
pub mod host;
