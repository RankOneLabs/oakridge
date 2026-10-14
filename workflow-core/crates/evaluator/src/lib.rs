//! Pure checked-program evaluation. All dynamic inputs are revalidated at this boundary.
mod v2_step {
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
    fn stage<'a>(program: &'a CheckedWorkflow, unit: &UnitState) -> Result<&'a Stage, StepError> {
        let key = unit
            .stage
            .as_ref()
            .ok_or_else(|| invalid("unit is a group"))?;
        program
            .source
            .stages
            .get(&key.0)
            .ok_or_else(|| invalid(format!("stage {key} absent")))
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
    fn worker<'a>(stage: &'a Stage, key: &WorkerKey) -> Result<&'a Worker, StepError> {
        stage
            .workers
            .get(&key.0)
            .ok_or_else(|| rejected(format!("worker {key} absent")))
    }
    fn creates(worker: &Worker) -> &[SymbolKey] {
        match worker {
            Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates,
        }
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
        // Kahn's algorithm over a ready queue, O(keys + dependencies): every key
        // must become reachable from an empty prerequisite set.
        let mut waiting: BTreeMap<&str, usize> = edges
            .iter()
            .map(|(key, named)| (*key, named.len()))
            .collect();
        let mut dependents: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (key, named) in &edges {
            for dependency in named {
                dependents.entry(*dependency).or_default().push(*key);
            }
        }
        let mut ready: Vec<&str> = waiting
            .iter()
            .filter(|(_, count)| **count == 0)
            .map(|(key, _)| *key)
            .collect();
        let mut reached = 0usize;
        while let Some(key) = ready.pop() {
            reached += 1;
            for dependent in dependents.get(key).map(Vec::as_slice).unwrap_or_default() {
                let count = waiting
                    .get_mut(dependent)
                    .expect("every dependent is a key");
                *count -= 1;
                if *count == 0 {
                    ready.push(dependent);
                }
            }
        }
        reached == keys.len()
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
        let eval =
            |inner: &Expression| eval_expression_inner(inner, unit, state, bindings, context);
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
                        let child = state.units.iter().find(|candidate| {
                            candidate.parent.as_ref() == Some(&unit.id)
                                && (candidate.declaration.0 == child_key.0
                                    || candidate.id.0.ends_with(&format!("/{child_key}")))
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
        let definition = stage(program, unit)?;
        let checked = checked_stage(program, unit)?;
        let mut wanted = Vec::new();
        for (key, definition_worker) in &definition.workers {
            let worker_key = WorkerKey::from(key.as_str());
            let Some(retry) = can_run(state, &unit.id, &worker_key) else {
                continue;
            };
            let checked_worker = checked
                .workers
                .iter()
                .find(|candidate| candidate.key == worker_key)
                .ok_or_else(|| invalid(format!("checked worker {worker_key} absent")))?;
            if !holds(checked_worker.when.as_ref(), unit, state, context)? {
                continue;
            }
            let candidate = match definition_worker {
                Worker::Agent {
                    creates,
                    reviews: Some(subject),
                    ..
                } => {
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
                Worker::Agent {
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
                        creates.iter().find_map(|artifact| {
                            let latest = latest(state, &unit.id, artifact)?;
                            state
                                .decisions
                                .iter()
                                .rev()
                                .find(|d| {
                                    d.unit == unit.id
                                        && d.target == latest.id
                                        && d.effect == DecisionEffect::RequestChanges
                                })
                                .map(|d| {
                                    (
                                        Mode::Revise,
                                        Cause::ChangesRequested {
                                            decision: d.id.clone(),
                                        },
                                    )
                                })
                        })
                    }
                }
                // Part 1 §5.2 rule 4: wanted only once its inputs resolve.
                Worker::Code { every: Some(_), .. } => {
                    eval_fields(&checked_worker.inputs, unit, state, None, context)?
                        .map(|_| (Mode::Initial, Cause::Periodic))
                }
                Worker::Code {
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
                    worker: worker_key,
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
        let definition = stage(program, unit)?;
        for review in &checked_stage(program, unit)?.reviews {
            let is_operator = definition
                .reviews
                .get(&review.key.0)
                .is_some_and(|source| source.by == ReviewBy::Operator);
            if !is_operator || !holds(review.when.as_ref(), unit, state, context)? {
                continue;
            }
            let Some(target) = latest(state, &unit.id, &review.of) else {
                continue;
            };
            let is_decided = state.decisions.iter().any(|decision| {
                decision.unit == unit.id
                    && decision.review == review.key
                    && decision.target == target.id
            });
            if is_decided {
                continue;
            }
            let mut inputs = serde_json::Map::new();
            for field in &review.inputs {
                let value =
                    eval_expression(&field.value.expression, unit, state, None, None, context)?;
                inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
            }
            resolved.push(ResolvedReview {
                unit: unit.id.clone(),
                review: review.key.clone(),
                target: target.id.clone(),
                inputs: Value::Object(inputs),
            });
        }
        Ok(resolved)
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
            .find(|candidate| candidate.key == *action.worker)
            .ok_or_else(|| invalid(format!("checked worker {} absent", action.worker)))?;
        let mut inputs = serde_json::Map::new();
        for field in &checked.inputs {
            let value = eval_expression(&field.value.expression, unit, state, None, None, context)?;
            inputs.insert(field.key.clone(), value.unwrap_or(Value::Null));
        }
        let workspace = match &checked.workspace {
            None => None,
            Some(expression) => Some(
                eval_expression(&expression.expression, unit, state, None, None, context)?
                    .ok_or_else(|| invalid(format!("workspace of {} unresolved", action.worker)))?,
            ),
        };
        let source = worker(stage(program, unit)?, action.worker)?;
        let (previous, feedback) = match action.mode {
            Mode::Revise => match changes_requested_on(state, &unit.id, creates(source)) {
                Some((revision, decision)) => {
                    (Some(revision.clone()), Some(decision.payload.clone()))
                }
                None => (None, None),
            },
            _ => (None, None),
        };
        let subject = match (action.mode, source) {
            (
                Mode::Review,
                Worker::Agent {
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
    /// The newest request_changes decision on the latest revision of one of
    /// `artifacts`, with that revision: what a revise attempt revises.
    fn changes_requested_on<'a>(
        state: &'a StepSnapshot,
        unit: &UnitId,
        artifacts: &[SymbolKey],
    ) -> Option<(&'a RevisionState, &'a DecisionState)> {
        state.decisions.iter().rev().find_map(|decision| {
            if decision.unit != *unit || decision.effect != DecisionEffect::RequestChanges {
                return None;
            }
            artifacts
                .iter()
                .filter_map(|artifact| latest(state, unit, artifact))
                .find(|revision| revision.id == decision.target)
                .map(|revision| (revision, decision))
        })
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
    ) -> Result<&'a Group, StepError> {
        if unit.id == state.run.root {
            return Ok(&program.source.run);
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
        let owner = group_for(program, state, parent)?;
        owner
            .units
            .get(&unit.declaration.0)
            .and_then(|u| u.group.as_deref())
            .ok_or_else(|| invalid("group declaration absent"))
    }
    /// The checked group mirroring group_for, so the engine can read compiled
    /// unit expressions instead of the source text beside them.
    fn checked_group_for<'a>(
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
        checked_group_for(program, state, parent)?
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
    fn check_type(
        ty: &TypeExpression,
        value: &Value,
        aliases: &BTreeMap<String, TypeExpression>,
    ) -> bool {
        if let TypeExpression::Name(name) = ty {
            if let Some(alias) = aliases.get(name) {
                return check_type(alias, value, aliases);
            }
        }
        match ty {
            TypeExpression::Record(fields) => value.as_object().is_some_and(|object| {
                fields
                    .iter()
                    .all(|(key, ty)| object.get(key).is_some_and(|v| check_type(ty, v, aliases)))
            }),
            TypeExpression::Name(name) if name == "text" || name == "repo_path" => {
                value.is_string()
            }
            TypeExpression::Name(name) if name == "ident" => value.as_str().is_some_and(is_ident),
            TypeExpression::Name(name) if name.starts_with("enum(") => name
                .strip_prefix("enum(")
                .and_then(|s| s.strip_suffix(')'))
                .is_some_and(|variants| {
                    value
                        .as_str()
                        .is_some_and(|text| variants.split(',').any(|v| v.trim() == text))
                }),
            TypeExpression::Name(name) if name == "boolean" => value.is_boolean(),
            TypeExpression::Name(name) if name == "integer" => value.is_i64(),
            TypeExpression::Name(name) if name.starts_with("optional(") => name
                .strip_prefix("optional(")
                .and_then(|s| s.strip_suffix(')'))
                .is_some_and(|inner| {
                    value.is_null() || check_type(&inline_type(inner), value, aliases)
                }),
            TypeExpression::Name(name) if name.starts_with("list(") => name
                .strip_prefix("list(")
                .and_then(|s| s.strip_suffix(')'))
                .is_some_and(|inner| {
                    value.as_array().is_some_and(|items| {
                        items
                            .iter()
                            .all(|item| check_type(&inline_type(inner), item, aliases))
                    })
                }),
            TypeExpression::Name(name) if name.starts_with('{') && name.ends_with('}') => {
                check_type(&inline_type(name), value, aliases)
            }
            _ => false,
        }
    }
    fn inline_type(text: &str) -> TypeExpression {
        let text = text.trim();
        let Some(body) = text.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
            return TypeExpression::Name(text.into());
        };
        let mut fields = BTreeMap::new();
        let mut depth = 0usize;
        let mut start = 0usize;
        for (index, ch) in body.char_indices() {
            match ch {
                '{' | '(' => depth += 1,
                '}' | ')' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    if let Some((key, ty)) = body[start..index].split_once(':') {
                        fields.insert(key.trim().into(), inline_type(ty));
                    }
                    start = index + 1;
                }
                _ => {}
            }
        }
        if let Some((key, ty)) = body[start..].split_once(':') {
            fields.insert(key.trim().into(), inline_type(ty));
        }
        TypeExpression::Record(fields)
    }
    /// The longest `ident`. Collection keys are idents taken from runtime data
    /// and every id under a member embeds its key, so an unbounded ident would
    /// make unbounded ids. 100 fits a GitHub repository or owner name, which
    /// `pull_request.observe` carries as idents.
    pub const MAX_IDENT_CHARS: usize = 100;
    /// `hash(unit, worker, mode, cause)` (part 1 §4): 32 hex characters, so an
    /// action's id is bounded however long its unit's path. The parts are
    /// hashed as their wire JSON, which their schemas fix, not as Rust's
    /// `Debug` output, which a refactor could change.
    fn action_id(unit: &UnitId, worker: &WorkerKey, mode: &Mode, cause: &Cause) -> ActionKey {
        use sha2::{Digest, Sha256};
        let parts = serde_json::json!([unit, worker, mode, cause]);
        let digest = Sha256::digest(parts.to_string().as_bytes());
        ActionKey(
            digest[..16]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        )
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
        let checked = checked_group_for(program, state, &parent)?.clone();
        for (key, unit) in &group.units {
            let collection = checked_unit(&checked, key)?.collection.clone();
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
                if member.is_empty()
                    || member.len() > 256
                    || member
                        .chars()
                        .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
                    || !keys.insert(member.clone())
                {
                    return Err(rejected(format!(
                        "collection {key} has illegal or duplicate key"
                    )));
                }
                let dependencies = match &unit.after {
                    UnitDependencies::None => vec![],
                    UnitDependencies::Fixed(items) => items.iter().map(|v| v.0.clone()).collect(),
                    UnitDependencies::Each(_) => {
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
                let declared_input = &checked_unit(&checked, key)?.input;
                let input = if unit.for_each.is_some() {
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
        let members: BTreeSet<_> = state
            .units
            .iter()
            .filter(|u| u.parent.as_ref() == Some(group_id))
            .map(|u| u.id.clone())
            .collect();
        if state
            .units
            .iter()
            .filter(|u| u.parent.as_ref() == Some(group_id))
            .any(|u| u.after.iter().any(|d| !members.contains(d)))
        {
            return Err(rejected("prerequisite references missing member"));
        }
        // Kahn's algorithm: every member must become reachable from an empty prerequisite set.
        let mut ready: BTreeSet<_> = state
            .units
            .iter()
            .filter(|u| u.parent.as_ref() == Some(group_id) && u.after.is_empty())
            .map(|u| u.id.clone())
            .collect();
        let mut visited = BTreeSet::new();
        while let Some(next) = ready.pop_first() {
            visited.insert(next.clone());
            for member in state
                .units
                .iter()
                .filter(|u| u.parent.as_ref() == Some(group_id) && u.after.contains(&next))
            {
                if member.after.iter().all(|d| visited.contains(d)) {
                    ready.insert(member.id.clone());
                }
            }
        }
        if visited != members {
            return Err(rejected("cyclic prerequisite"));
        }
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
                if !check_type(&program.source.input, input, &program.source.schemas) {
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
                materialize_group(program, state, &root, context)?;
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
                    AttemptStatus::Succeeded if matches!(old.cause, Cause::Periodic) => {
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
                let definition = worker(stage(program, unit)?, &attempt.worker)?;
                state.attempts[index].status = match result {
                    WorkerResult::Failed { code, detail } => AttemptStatus::Failed {
                        code: code.clone(),
                        detail: detail.clone(),
                    },
                    WorkerResult::Succeeded
                        if !matches!(attempt.cause, Cause::Periodic)
                            && creates(definition).iter().any(|artifact| {
                                !state.revisions.iter().any(|r| {
                                    r.by.as_ref() == Some(&attempt.action_id)
                                        && r.artifact == *artifact
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
                let definition = stage(program, owner)?.clone();
                let artifact_definition = definition
                    .artifacts
                    .get(&artifact.0)
                    .ok_or_else(|| rejected("artifact absent"))?;
                if !check_type(&artifact_definition.schema, body, &program.source.schemas) {
                    return Err(rejected("artifact body fails schema"));
                }
                // A revision is its body and what it reviews: the same body about a
                // new subject (a reviewer repeating itself on a new revision) is new.
                let is_unchanged = |revision: &RevisionState| {
                    revision.body == *body && revision.subject == *subject
                };
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
                        if !creates(producer).contains(artifact) {
                            return Err(rejected("worker does not create artifact"));
                        }
                        producer
                    }
                    None => definition
                        .workers
                        .values()
                        .find(|candidate| creates(candidate).contains(artifact))
                        .ok_or_else(|| invalid("artifact has no creator"))?,
                };
                let is_code = matches!(producer, Worker::Code { .. });
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
                let checked_checks = checked_stage(program, owner)?
                    .validations
                    .iter()
                    .find(|validation| validation.artifact == *artifact)
                    .map(|validation| validation.checks.as_slice())
                    .unwrap_or_default();
                let mut messages = Vec::new();
                for (rule, checked) in artifact_definition.validate.iter().zip(checked_checks) {
                    if eval_expression(
                        &checked.expression,
                        owner,
                        state,
                        None,
                        Some((&artifact.0, body)),
                        context,
                    )? != Some(Value::Bool(true))
                    {
                        messages.push(rule.message.clone());
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
                let definition = stage(program, owner)?;
                let review_definition = definition
                    .reviews
                    .get(&review.0)
                    .ok_or_else(|| rejected("review absent"))?;
                let decision_definition = review_definition
                    .decisions
                    .get(&decision.0)
                    .ok_or_else(|| rejected("decision absent"))?;
                if review_definition.by == ReviewBy::Engine {
                    return Err(rejected("the engine decides this review"));
                }
                let checked_review = checked_stage(program, owner)?
                    .reviews
                    .iter()
                    .find(|candidate| candidate.key == *review)
                    .ok_or_else(|| invalid(format!("checked review {review} absent")))?;
                if !holds(checked_review.when.as_ref(), owner, state, context)? {
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
                let target_artifact = decision_definition
                    .on
                    .as_ref()
                    .unwrap_or(&review_definition.of);
                let current = latest(state, unit, target_artifact)
                    .ok_or_else(|| rejected("reviewed artifact unpublished"))?;
                if current.id != *target {
                    return Err(rejected("target is not latest revision"));
                }
                if state
                    .decisions
                    .iter()
                    .any(|d| d.unit == *unit && d.review == *review && d.target == *target)
                {
                    return Err(rejected("review already decided on latest revision"));
                }
                if let Some(ty) = &decision_definition.payload {
                    if !check_type(ty, payload, &program.source.schemas) {
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
                let previous = attempt(state, unit, worker)
                    .ok_or_else(|| rejected("worker has no attempt"))?;
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
        context: &EvaluationContext<'_>,
    ) -> Result<Option<DecisionState>, StepError> {
        let definition = stage(program, unit)?;
        for review in &checked_stage(program, unit)?.reviews {
            let Some(source) = definition.reviews.get(&review.key.0) else {
                continue;
            };
            if source.by != ReviewBy::Engine {
                continue;
            }
            let Some((decision_key, decision)) = source.decisions.iter().next() else {
                continue;
            };
            let target_artifact = decision.on.as_ref().unwrap_or(&source.of);
            let Some(target) = latest(state, &unit.id, target_artifact) else {
                continue;
            };
            // Wait for the target's creator to finish its attempt: a revise that
            // has published the new target but not yet the rest of its output
            // (a replacement PR) would otherwise be judged on what it replaces.
            let is_creator_working = definition
                .workers
                .iter()
                .filter(|(_, worker)| creates(worker).contains(target_artifact))
                .any(|(key, _)| {
                    attempt(state, &unit.id, &WorkerKey::from(key.as_str())).is_some_and(
                        |current| {
                            matches!(
                                current.status,
                                AttemptStatus::Pending | AttemptStatus::Running
                            )
                        },
                    )
                });
            if is_creator_working {
                continue;
            }
            let is_decided = state.decisions.iter().any(|existing| {
                existing.unit == unit.id
                    && existing.review == review.key
                    && existing.target == target.id
            });
            if is_decided || !holds(review.when.as_ref(), unit, state, context)? {
                continue;
            }
            return Ok(Some(DecisionState {
                id: decision_id(state, &unit.id),
                unit: unit.id.clone(),
                review: review.key.clone(),
                decision: SymbolKey::from(decision_key.as_str()),
                effect: decision.effect.clone(),
                target: target.id.clone(),
                payload: serde_json::json!({ "feedback": decision.feedback.clone().unwrap_or_default() }),
            }));
        }
        Ok(None)
    }
    fn advance(
        program: &CheckedWorkflow,
        state: &mut StepSnapshot,
        context: &EvaluationContext<'_>,
    ) -> Result<bool, StepError> {
        for index in 0..state.units.len() {
            let unit = state.units[index].clone();
            if matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled) {
                continue;
            }
            if unit.stage.is_some() && matches!(unit.status, UnitStatus::Active) {
                let definition = checked_stage(program, &unit)?;
                if eval_expression(
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
                if let Some(decision) = engine_decision(program, state, &unit, context)? {
                    state.decisions.push(decision);
                    return Ok(true);
                }
            }
            if unit.stage.is_none() && matches!(unit.status, UnitStatus::Active) {
                let children: Vec<_> = state
                    .units
                    .iter()
                    .filter(|u| u.parent.as_ref() == Some(&unit.id))
                    .collect();
                if !children.is_empty()
                    && children
                        .iter()
                        .all(|u| matches!(u.status, UnitStatus::Done { .. }))
                {
                    let outcome = eval_fields(
                        &checked_group_for(program, state, &unit)?.outcome,
                        &unit,
                        state,
                        None,
                        context,
                    )?
                    .ok_or_else(|| invalid("group outcome unresolved"))?;
                    state.units[index].status = UnitStatus::Done { outcome };
                    return Ok(true);
                }
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
                continue;
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
                    continue;
                }
            }
            if unit.input.is_null() {
                let parent = state
                    .units
                    .iter()
                    .find(|u| Some(&u.id) == unit.parent.as_ref())
                    .ok_or_else(|| invalid("parent absent"))?;
                let declared = checked_unit(
                    checked_group_for(program, state, parent)?,
                    &unit.declaration.0,
                )?;
                state.units[index].input =
                    eval_fields(&declared.input, parent, state, None, context)?
                        .ok_or_else(|| invalid("unit input unresolved"))?;
            }
            state.units[index].status = UnitStatus::Active;
            if unit.stage.is_none() {
                materialize_group(program, state, &unit.id, context)?;
            }
            return Ok(true);
        }
        Ok(false)
    }
    /// Pure reducer and bounded internal Start/Complete fixpoint. The snapshot carries
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
        if !matches!(state.run.status, UnitStatus::Cancelled) {
            while advance(program, &mut state, &context)? {}
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
            let stage_unit = unit.clone();
            let actions = stage_actions(program, &state, &unit, &context)?;
            for action in &actions {
                if let Action::RunWorker {
                    unit,
                    worker,
                    mode,
                    cause,
                } = action
                {
                    let id = action_id(unit, worker, mode, cause);
                    resolved.push(resolve_run_worker(
                        program,
                        &state,
                        &stage_unit,
                        &RunWorkerAction {
                            worker,
                            mode,
                            cause,
                        },
                        &context,
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
            }
            reviews.extend(resolve_reviews(program, &state, &stage_unit, &context)?);
            wanted.push((unit.id, actions));
        }
        let statuses = state
            .units
            .iter()
            .map(|u| (u.id.clone(), u.status.clone()))
            .collect();
        Ok(StepResult {
            snapshot: state,
            statuses,
            wanted,
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
            let aliases = BTreeMap::from([
                ("title".into(), TypeExpression::Name("text".into())),
                ("titles".into(), TypeExpression::Name("list(title)".into())),
            ]);
            let ty = TypeExpression::Record(BTreeMap::from([(
                "items".into(),
                TypeExpression::Name("optional(titles)".into()),
            )]));
            assert!(check_type(
                &ty,
                &serde_json::json!({"items": ["one"]}),
                &aliases
            ));
            assert!(check_type(
                &ty,
                &serde_json::json!({"items": null}),
                &aliases
            ));
            assert!(!check_type(
                &ty,
                &serde_json::json!({"items": [1]}),
                &aliases
            ));
        }

        #[test]
        fn host_limits_reject_large_inputs_and_exhausted_expression_budget() {
            let program = sample("fan-out");
            let trace: Value =
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
            let stage = program.source.stages.get_mut("document").unwrap();
            let Worker::Agent { creates, .. } = stage.workers.get_mut("critic").unwrap() else {
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
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
                serde_json::from_str(include_str!("../../../fixtures/bundles/fan-out.json"))
                    .unwrap();
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
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
            program
                .source
                .stages
                .get_mut("document")
                .unwrap()
                .reviews
                .get_mut("editor")
                .unwrap()
                .decisions
                .get_mut("approve")
                .unwrap()
                .on = Some(SymbolKey::from("critique"));
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
        fn step_specs(
            program: &CheckedWorkflow,
            state: &StepSnapshot,
            specs: &[Value],
        ) -> StepResult {
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
        #[test]
        fn repository_workspace_resolves_from_the_stage_input() {
            let program = sample("fan-out");
            let trace: Value =
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
                .any(|a| a.unit.0 == "run/work/b"
                    && matches!(a.status, AttemptStatus::Failed { .. })));
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
        #[test]
        fn cancel_is_terminal_and_idempotent_across_the_group_tree() {
            let program = sample("fan-out");
            let trace: Value =
                serde_json::from_str(include_str!("../../../fixtures/traces/fan-out.json"))
                    .unwrap();
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
            assert!(cancelled.snapshot.units.iter().all(|unit| matches!(
                unit.status,
                UnitStatus::Done { .. } | UnitStatus::Cancelled
            )));
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
}
pub use v2_step::{step, step_with_limits};
pub mod host;
