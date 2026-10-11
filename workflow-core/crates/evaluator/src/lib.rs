//! Pure checked-program evaluation. All dynamic inputs are revalidated at this boundary.
mod collections;
mod expressions;
mod v2_step {
    use std::collections::{BTreeMap, BTreeSet};
    use serde_json::{Map, Value};
    use workflow_model::*;

    fn rejected(reason: impl Into<String>) -> StepError { StepError::Rejected { reason: reason.into() } }
    fn invalid(detail: impl Into<String>) -> StepError { StepError::Invalid { detail: detail.into() } }
    fn latest<'a>(state: &'a ScopedSnapshot, unit: &UnitId, artifact: &SymbolKey) -> Option<&'a RevisionState> {
        state.revisions.iter().rev().find(|r| r.unit == *unit && r.artifact == *artifact)
    }
    fn stage<'a>(program: &'a CheckedWorkflow, unit: &UnitState) -> Result<&'a Stage, StepError> {
        let key = unit.stage.as_ref().ok_or_else(|| invalid("unit is a group"))?;
        program.source.stages.get(&key.0).ok_or_else(|| invalid(format!("stage {key} absent")))
    }
    fn worker<'a>(stage: &'a Stage, key: &WorkerKey) -> Result<&'a Worker, StepError> {
        stage.workers.get(&key.0).ok_or_else(|| rejected(format!("worker {key} absent")))
    }
    fn creates(worker: &Worker) -> &[SymbolKey] {
        match worker { Worker::Agent { creates, .. } | Worker::Code { creates, .. } => creates }
    }
    fn attempt<'a>(state: &'a ScopedSnapshot, unit: &UnitId, worker: &WorkerKey) -> Option<&'a AttemptState> {
        state.attempts.iter().rev().find(|a| a.unit == *unit && a.worker == *worker)
    }
    fn revision_id(state: &ScopedSnapshot) -> RevisionId { RevisionId(format!("r{}", state.revisions.len() + 1)) }
    fn decision_id(state: &ScopedSnapshot) -> DecisionId { DecisionId(format!("d{}", state.decisions.len() + 1)) }
    fn path(value: &Value, parts: &[&str]) -> Option<Value> {
        let mut current = value;
        for part in parts { current = current.get(*part)?; }
        Some(current.clone())
    }
    fn split_args(text: &str) -> Vec<&str> {
        let mut depth = 0usize;
        let mut start = 0usize;
        let mut args = Vec::new();
        for (index, ch) in text.char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => { args.push(text[start..index].trim()); start = index + 1; }
                _ => {}
            }
        }
        args.push(text[start..].trim());
        args
    }
    fn function<'a>(text: &'a str, name: &str) -> Option<&'a str> {
        text.strip_prefix(name)?.strip_prefix('(')?.strip_suffix(')')
    }
    fn eval(text: &str, unit: &UnitState, state: &ScopedSnapshot, each: Option<&Value>, own_body: Option<(&str, &Value)>) -> Option<Value> {
        let text = text.trim();
        if let Some(body) = function(text, "len") {
            let value = eval(body, unit, state, each, own_body)?;
            return Some(Value::from(match value { Value::String(s) => s.chars().count(), Value::Array(a) => a.len(), _ => return None }));
        }
        for (symbol, compare) in [(" >= ", 0), (" <= ", 1), (" > ", 2), (" < ", 3)] {
            if let Some((left, right)) = text.split_once(symbol) {
                let left = eval(left, unit, state, each, own_body)?.as_i64()?;
                let right = eval(right, unit, state, each, own_body)?.as_i64()?;
                return Some(Value::Bool(match compare { 0 => left >= right, 1 => left <= right, 2 => left > right, _ => left < right }));
            }
        }
        for (name, kind) in [("latest", 0), ("published", 1), ("approved", 2), ("changes_requested", 3)] {
            if let Some(artifact) = function(text, name) {
                let revision = latest(state, &unit.id, &SymbolKey::from(artifact.trim()));
                return Some(match kind {
                    0 => revision.map(|r| r.body.clone()).unwrap_or(Value::Null),
                    1 => Value::Bool(revision.is_some()),
                    2 | 3 => Value::Bool(revision.is_some_and(|r| state.decisions.iter().any(|d| d.unit == unit.id && d.target == r.id && d.effect == if kind == 2 { DecisionEffect::Approve } else { DecisionEffect::RequestChanges }))),
                    _ => unreachable!(),
                });
            }
        }
        if let Some(rest) = text.strip_prefix("input.") { return path(&unit.input, &rest.split('.').collect::<Vec<_>>()); }
        if text == "input" { return Some(unit.input.clone()); }
        if let Some(rest) = text.strip_prefix("each.") { return path(each?, &rest.split('.').collect::<Vec<_>>()); }
        if text == "each" { return each.cloned(); }
        if let Some((artifact, body)) = own_body {
            if text == artifact { return Some(body.clone()); }
            if let Some(rest) = text.strip_prefix(artifact).and_then(|v| v.strip_prefix('.')) {
                return path(body, &rest.split('.').collect::<Vec<_>>());
            }
        }
        if let Some((child, rest)) = text.split_once(".outcome") {
            let child = state.units.iter().find(|candidate| candidate.parent.as_ref() == Some(&unit.id) && (candidate.declaration.0 == child || candidate.id.0.ends_with(&format!("/{child}"))))?;
            let UnitStatus::Done { outcome } = &child.status else { return None };
            return if rest.is_empty() { Some(outcome.clone()) } else { path(outcome, &rest.strip_prefix('.')?.split('.').collect::<Vec<_>>()) };
        }
        if let Some(rest) = text.strip_prefix("latest(") {
            let (artifact, suffix) = rest.split_once(')')?;
            let body = latest(state, &unit.id, &SymbolKey::from(artifact))?.body.clone();
            return if suffix.is_empty() { Some(body) } else { path(&body, &suffix.strip_prefix('.')?.split('.').collect::<Vec<_>>()) };
        }
        if text == "true" { return Some(Value::Bool(true)); }
        if text == "false" { return Some(Value::Bool(false)); }
        if let Ok(value) = text.parse::<i64>() { return Some(Value::from(value)); }
        if text.starts_with('"') { return serde_json::from_str(text).ok(); }
        None
    }
    fn eval_record(fields: &BTreeMap<String, String>, unit: &UnitState, state: &ScopedSnapshot, each: Option<&Value>) -> Option<Value> {
        let mut value = Map::new();
        for (key, source) in fields { value.insert(key.clone(), eval(source, unit, state, each, None)?); }
        Some(Value::Object(value))
    }
    fn action_id(unit: &UnitId, worker: &WorkerKey, mode: &Mode, cause: &Cause) -> ActionKey {
        ActionKey(format!("{}:{}:{mode:?}:{cause:?}", unit.0, worker.0))
    }
    fn latest_retry<'a>(state: &'a ScopedSnapshot, unit: &UnitId, worker: &WorkerKey) -> Option<&'a EventId> {
        state.retry_events.iter().rev().find(|(u, w, _)| u == unit && w == worker).map(|(_, _, id)| id)
    }
    fn can_run(state: &ScopedSnapshot, unit: &UnitId, worker: &WorkerKey) -> Option<Option<Cause>> {
        let Some(previous) = attempt(state, unit, worker) else { return Some(None) };
        match previous.status {
            AttemptStatus::Pending | AttemptStatus::Running => None,
            AttemptStatus::Failed { .. } => {
                let retry = latest_retry(state, unit, worker)?;
                if matches!(previous.cause, Cause::Retry { ref event } if event == retry) { None }
                else { Some(Some(Cause::Retry { event: retry.clone() })) }
            }
            AttemptStatus::Succeeded => Some(None),
        }
    }
    fn stage_actions(program: &CheckedWorkflow, state: &ScopedSnapshot, unit: &UnitState) -> Result<Vec<Action>, StepError> {
        let definition = stage(program, unit)?;
        let mut wanted = Vec::new();
        for (key, definition_worker) in &definition.workers {
            let worker_key = WorkerKey::from(key.as_str());
            let Some(retry) = can_run(state, &unit.id, &worker_key) else { continue };
            let candidate = match definition_worker {
                Worker::Agent { creates, reviews: Some(subject), .. } => {
                    let Some(subject) = latest(state, &unit.id, subject) else { continue };
                    let already = creates.iter().any(|artifact| state.revisions.iter().any(|r| r.unit == unit.id && r.artifact == *artifact && r.subject.as_ref() == Some(&subject.id)));
                    if already { None } else { Some((Mode::Review, Cause::ReviewOf { revision: subject.id.clone() })) }
                }
                Worker::Agent { creates, reviews: None, .. } => {
                    if creates.iter().any(|artifact| latest(state, &unit.id, artifact).is_none()) { Some((Mode::Initial, Cause::Missing)) }
                    else {
                        creates.iter().find_map(|artifact| {
                            let latest = latest(state, &unit.id, artifact)?;
                            state.decisions.iter().rev().find(|d| d.unit == unit.id && d.target == latest.id && d.effect == DecisionEffect::RequestChanges).map(|d| (Mode::Revise, Cause::ChangesRequested { decision: d.id.clone() }))
                        })
                    }
                }
                Worker::Code { every: Some(_), .. } => Some((Mode::Initial, Cause::Periodic)),
                Worker::Code { creates, every: None, .. } => if creates.iter().any(|artifact| latest(state, &unit.id, artifact).is_none()) { Some((Mode::Initial, Cause::Missing)) } else { None },
            };
            if let Some((mode, cause)) = candidate {
                let cause = retry.unwrap_or(cause);
                wanted.push(Action::RunWorker { unit: unit.id.clone(), worker: worker_key, mode, cause });
            }
        }
        Ok(wanted)
    }
    fn group_for<'a>(program: &'a CheckedWorkflow, state: &ScopedSnapshot, unit: &UnitState) -> Result<&'a Group, StepError> {
        if unit.id == state.run.root { return Ok(&program.source.run); }
        let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("group has no parent"))?;
        let parent = state.units.iter().find(|u| u.id == *parent_id).ok_or_else(|| invalid("parent absent"))?;
        let owner = group_for(program, state, parent)?;
        owner.units.get(&unit.declaration.0).and_then(|u| u.group.as_deref()).ok_or_else(|| invalid("group declaration absent"))
    }
    fn unit_definition<'a>(program: &'a CheckedWorkflow, state: &ScopedSnapshot, unit: &UnitState) -> Result<&'a Unit, StepError> {
        let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("root has no unit declaration"))?;
        let parent = state.units.iter().find(|u| u.id == *parent_id).ok_or_else(|| invalid("parent absent"))?;
        group_for(program, state, parent)?.units.get(&unit.declaration.0).ok_or_else(|| invalid("unit declaration absent"))
    }
    fn check_type(ty: &TypeExpression, value: &Value) -> bool {
        match ty {
            TypeExpression::Record(fields) => value.as_object().is_some_and(|object| fields.iter().all(|(key, ty)| object.get(key).is_some_and(|v| check_type(ty, v)))),
            TypeExpression::Name(name) if name == "text" || name == "ident" || name == "repo_path" => value.is_string(),
            TypeExpression::Name(name) if name == "boolean" => value.is_boolean(),
            TypeExpression::Name(name) if name == "integer" => value.is_i64(),
            TypeExpression::Name(name) if name.starts_with("optional(") => value.is_null() || check_type(&TypeExpression::Name(name[9..name.len()-1].to_owned()), value),
            TypeExpression::Name(name) if name.starts_with("list(") => value.as_array().is_some_and(|items| items.iter().all(|v| check_type(&TypeExpression::Name(name[5..name.len()-1].to_owned()), v))),
            _ => true,
        }
    }
    fn materialize_group(program: &CheckedWorkflow, state: &mut ScopedSnapshot, group_id: &UnitId) -> Result<(), StepError> {
        let parent = state.units.iter().find(|u| u.id == *group_id).cloned().ok_or_else(|| invalid("group absent"))?;
        let group = group_for(program, state, &parent)?.clone();
        for (key, unit) in &group.units {
            let each_values = if let Some(source) = &unit.for_each {
                eval(source, &parent, state, None, None).and_then(|v| v.as_array().cloned()).ok_or_else(|| rejected(format!("collection {key} source is not a list")))?
            } else { vec![Value::Null] };
            let mut keys = BTreeSet::new();
            for each in &each_values {
                let member = if let Some(source) = &unit.key {
                    eval(source, &parent, state, Some(each), None).and_then(|v| v.as_str().map(str::to_owned)).ok_or_else(|| rejected(format!("collection {key} key is not text")))?
                } else { key.clone() };
                if member.is_empty() || member.len() > 256 || member.chars().any(|ch| ch.is_control() || ch == '/' || ch == '\\') || !keys.insert(member.clone()) {
                    return Err(rejected(format!("collection {key} has illegal or duplicate key")));
                }
                let dependencies = match &unit.after {
                    UnitDependencies::None => vec![],
                    UnitDependencies::Fixed(items) => items.iter().map(|v| v.0.clone()).collect(),
                    UnitDependencies::Each(source) => eval(source, &parent, state, Some(each), None)
                        .and_then(|v| v.as_array().cloned())
                        .ok_or_else(|| rejected(format!("collection {key} after is not a list")))?
                        .iter().map(|v| v.as_str().map(str::to_owned).ok_or_else(|| rejected("prerequisite key is not text"))).collect::<Result<Vec<_>, _>>()?,
                };
                let input = if unit.for_each.is_some() { eval_record(&unit.input, &parent, state, Some(each)).ok_or_else(|| rejected("collection input unresolved"))? } else { Value::Null };
                state.units.push(UnitState {
                    id: UnitId(format!("{group_id}/{member}")), parent: Some(group_id.clone()), declaration: SymbolKey::from(key.as_str()), stage: unit.stage.clone(),
                    status: UnitStatus::NotStarted, input, after: dependencies.into_iter().map(|d| UnitId(format!("{group_id}/{d}"))).collect(), pool: unit.pool.clone(),
                });
            }
        }
        let members: BTreeSet<_> = state.units.iter().filter(|u| u.parent.as_ref() == Some(group_id)).map(|u| u.id.clone()).collect();
        if state.units.iter().filter(|u| u.parent.as_ref() == Some(group_id)).any(|u| u.after.iter().any(|d| !members.contains(d))) {
            return Err(rejected("prerequisite references missing member"));
        }
        // Kahn's algorithm: every member must become reachable from an empty prerequisite set.
        let mut ready: BTreeSet<_> = state.units.iter().filter(|u| u.parent.as_ref() == Some(group_id) && u.after.is_empty()).map(|u| u.id.clone()).collect();
        let mut visited = BTreeSet::new();
        while let Some(next) = ready.pop_first() {
            visited.insert(next.clone());
            for member in state.units.iter().filter(|u| u.parent.as_ref() == Some(group_id) && u.after.contains(&next)) {
                if member.after.iter().all(|d| visited.contains(d)) { ready.insert(member.id.clone()); }
            }
        }
        if visited != members { return Err(rejected("cyclic prerequisite")); }
        Ok(())
    }
    fn reduce(program: &CheckedWorkflow, state: &mut ScopedSnapshot, incoming: &Incoming) -> Result<(), StepError> {
        match &incoming.event {
            Event::Launched { input } => {
                if state.run.input.is_some() { return Ok(()); }
                if !check_type(&program.source.input, input) { return Err(rejected("launch input fails schema")); }
                state.run.input = Some(input.clone());
                state.run.status = UnitStatus::Active;
                state.units.push(UnitState { id: state.run.root.clone(), parent: None, declaration: SymbolKey::from("$root"), stage: None,
                    status: UnitStatus::Active, input: input.clone(), after: vec![], pool: None });
                let root = state.run.root.clone();
                materialize_group(program, state, &root)?;
            }
            Event::WorkerStarted { action, kbbl_session_id } => {
                let index = state.attempts.iter().rposition(|a| a.action_id == *action).ok_or_else(|| rejected("action absent"))?;
                let old = state.attempts[index].clone();
                match old.status {
                    AttemptStatus::Pending => { state.attempts[index].status = AttemptStatus::Running; state.attempts[index].kbbl_session_id = kbbl_session_id.clone(); }
                    AttemptStatus::Running => {}
                    AttemptStatus::Succeeded if matches!(old.cause, Cause::Periodic) => {
                        state.attempts.push(AttemptState { seq: old.seq + 1, status: AttemptStatus::Running, kbbl_session_id: kbbl_session_id.clone(), ended_at: None, ..old });
                    }
                    _ => {}
                }
            }
            Event::WorkerEnded { action, result } => {
                let index = state.attempts.iter().rposition(|a| a.action_id == *action).ok_or_else(|| rejected("action absent"))?;
                if matches!(state.attempts[index].status, AttemptStatus::Succeeded | AttemptStatus::Failed { .. }) { return Ok(()); }
                let attempt = state.attempts[index].clone();
                let unit = state.units.iter().find(|u| u.id == attempt.unit).ok_or_else(|| invalid("attempt unit absent"))?;
                let definition = worker(stage(program, unit)?, &attempt.worker)?;
                state.attempts[index].status = match result {
                    WorkerResult::Failed { code, detail } => AttemptStatus::Failed { code: code.clone(), detail: detail.clone() },
                    WorkerResult::Succeeded if !matches!(attempt.cause, Cause::Periodic) && creates(definition).iter().any(|artifact| !state.revisions.iter().any(|r| r.by == attempt.action_id && r.artifact == *artifact)) => AttemptStatus::Failed { code: "no_output".into(), detail: "worker ended before publishing every artifact".into() },
                    WorkerResult::Succeeded => AttemptStatus::Succeeded,
                };
                state.attempts[index].ended_at = Some(attempt.seq as i64);
            }
            Event::RevisionPublished { unit, artifact, body, predecessor, subject, by } => {
                let owner = state.units.iter().find(|u| u.id == *unit).ok_or_else(|| rejected("unit absent"))?;
                if !matches!(owner.status, UnitStatus::Active) { return Err(rejected("unit is not active")); }
                let definition = stage(program, owner)?.clone();
                let artifact_definition = definition.artifacts.get(&artifact.0).ok_or_else(|| rejected("artifact absent"))?;
                if !check_type(&artifact_definition.schema, body) { return Err(rejected("artifact body fails schema")); }
                let attempt_index = state.attempts.iter().rposition(|a| a.action_id == *by && a.unit == *unit && matches!(a.status, AttemptStatus::Pending | AttemptStatus::Running)).ok_or_else(|| rejected("publication attempt is not current"))?;
                let attempt = state.attempts[attempt_index].clone();
                let producer = worker(&definition, &attempt.worker)?;
                if !creates(producer).contains(artifact) { return Err(rejected("worker does not create artifact")); }
                let previous = latest(state, unit, artifact);
                if previous.is_some_and(|r| r.body == *body) { return Ok(()); }
                if previous.map(|r| &r.id) != predecessor.as_ref() { return Err(rejected("stale predecessor")); }
                let id = revision_id(state);
                state.revisions.push(RevisionState { id: id.clone(), unit: unit.clone(), artifact: artifact.clone(), body: body.clone(), predecessor: predecessor.clone(), subject: subject.clone(), by: by.clone() });
                let messages: Vec<_> = artifact_definition.validate.iter().filter(|check| eval(&check.check, owner, state, None, Some((&artifact.0, body))) != Some(Value::Bool(true))).map(|check| check.message.clone()).collect();
                if !messages.is_empty() {
                    if matches!(producer, Worker::Code { .. }) {
                        state.attempts[attempt_index].status = AttemptStatus::Failed { code: "validation_failed".into(), detail: messages.join("; ") };
                        state.attempts[attempt_index].ended_at = Some(attempt.seq as i64);
                    } else {
                        let decision = decision_id(state);
                        state.decisions.push(DecisionState { id: decision, unit: unit.clone(), review: SymbolKey::from("engine:validator"), decision: SymbolKey::from("request_changes"), effect: DecisionEffect::RequestChanges, target: id, payload: serde_json::json!({"feedback": messages.join("; ")}) });
                    }
                }
            }
            Event::OperatorDecided { unit, review, decision, target, payload } => {
                let owner = state.units.iter().find(|u| u.id == *unit).ok_or_else(|| rejected("unit absent"))?;
                let definition = stage(program, owner)?;
                let review_definition = definition.reviews.get(&review.0).ok_or_else(|| rejected("review absent"))?;
                let decision_definition = review_definition.decisions.get(&decision.0).ok_or_else(|| rejected("decision absent"))?;
                let current = latest(state, unit, &review_definition.of).ok_or_else(|| rejected("reviewed artifact unpublished"))?;
                if current.id != *target { return Err(rejected("target is not latest revision")); }
                if state.decisions.iter().any(|d| d.unit == *unit && d.review == *review && d.target == *target) { return Ok(()); }
                if let Some(ty) = &decision_definition.payload { if !check_type(ty, payload) { return Err(rejected("decision payload fails schema")); } }
                if decision_definition.effect == DecisionEffect::RequestChanges && payload.get("feedback").and_then(Value::as_str).is_none_or(str::is_empty) { return Err(rejected("request_changes requires feedback")); }
                let id = decision_id(state);
                state.decisions.push(DecisionState { id, unit: unit.clone(), review: review.clone(), decision: decision.clone(), effect: decision_definition.effect.clone(), target: target.clone(), payload: payload.clone() });
            }
            Event::RetryRequested { unit, worker } => {
                let previous = attempt(state, unit, worker).ok_or_else(|| rejected("worker has no attempt"))?;
                if !matches!(previous.status, AttemptStatus::Failed { .. }) { return Err(rejected("latest attempt has not failed")); }
                if let Some(last) = latest_retry(state, unit, worker) {
                    if matches!(&previous.cause, Cause::Retry { event } if event != last) { return Ok(()); }
                    if incoming.ingress_id.as_deref() == Some(&last.0) { return Ok(()); }
                }
                let id = EventId(incoming.ingress_id.clone().unwrap_or_else(|| format!("retry:{}", state.retry_events.len() + 1)));
                state.retry_events.push((unit.clone(), worker.clone(), id));
            }
            Event::CancelRequested => {
                for unit in &mut state.units { if !matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled) { unit.status = UnitStatus::Cancelled; } }
                state.run.status = UnitStatus::Cancelled;
            }
        }
        Ok(())
    }
    fn group_outcome(group: &Group, owner: &UnitState, state: &ScopedSnapshot) -> Option<Value> {
        let mut fields = Map::new();
        for (key, source) in &group.outcome {
            if let Some(inner) = function(source, "map") {
                let args = split_args(inner);
                if args.len() != 2 { return None; }
                let mut values = Vec::new();
                for child in state.units.iter().filter(|u| u.parent.as_ref() == Some(&owner.id) && u.declaration.0 == args[0]) {
                    let UnitStatus::Done { outcome } = &child.status else { return None };
                    let suffix = args[1].strip_prefix(args[0])?.strip_prefix(".outcome")?;
                    let value = if suffix.is_empty() { outcome.clone() } else { path(outcome, &suffix.strip_prefix('.')?.split('.').collect::<Vec<_>>())? };
                    values.push(value);
                }
                fields.insert(key.clone(), Value::Array(values));
            } else { fields.insert(key.clone(), eval(source, owner, state, None, None)?); }
        }
        Some(Value::Object(fields))
    }
    fn advance(program: &CheckedWorkflow, state: &mut ScopedSnapshot) -> Result<bool, StepError> {
        for index in 0..state.units.len() {
            let unit = state.units[index].clone();
            if matches!(unit.status, UnitStatus::Done { .. } | UnitStatus::Cancelled) { continue; }
            if unit.stage.is_some() && matches!(unit.status, UnitStatus::Active) {
                let definition = stage(program, &unit)?;
                if definition.done_when.as_ref().and_then(|s| eval(s, &unit, state, None, None)) == Some(Value::Bool(true)) {
                    let outcome = eval_record(&definition.outcome, &unit, state, None).ok_or_else(|| invalid("stage outcome unresolved"))?;
                    state.units[index].status = UnitStatus::Done { outcome };
                    return Ok(true);
                }
            }
            if unit.stage.is_none() && matches!(unit.status, UnitStatus::Active) {
                let children: Vec<_> = state.units.iter().filter(|u| u.parent.as_ref() == Some(&unit.id)).collect();
                if !children.is_empty() && children.iter().all(|u| matches!(u.status, UnitStatus::Done { .. })) {
                    let outcome = group_outcome(group_for(program, state, &unit)?, &unit, state).ok_or_else(|| invalid("group outcome unresolved"))?;
                    state.units[index].status = UnitStatus::Done { outcome };
                    return Ok(true);
                }
            }
        }
        let mut candidates: Vec<_> = state.units.iter().enumerate().filter(|(_, u)| matches!(u.status, UnitStatus::NotStarted | UnitStatus::Blocked { .. })).map(|(i, _)| i).collect();
        candidates.sort_by_key(|&index| state.units[index].id.clone());
        for index in candidates {
            let unit = state.units[index].clone();
            let waiting: Vec<_> = unit.after.iter().filter(|dep| !state.units.iter().any(|u| u.id == **dep && matches!(u.status, UnitStatus::Done { .. }))).cloned().collect();
            if !waiting.is_empty() {
                state.units[index].status = UnitStatus::Blocked { reason: BlockedReason::WaitingOn { units: waiting } };
                continue;
            }
            if let Some(pool) = &unit.pool {
                let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("pooled root"))?;
                let parent = state.units.iter().find(|u| u.id == *parent_id).ok_or_else(|| invalid("pool owner absent"))?;
                let capacity = *group_for(program, state, parent)?.pools.get(&pool.0).ok_or_else(|| invalid("pool absent"))? as usize;
                let held = state.units.iter().filter(|u| u.parent.as_ref() == Some(parent_id) && u.pool.as_ref() == Some(pool) && matches!(u.status, UnitStatus::Active)).count();
                if held >= capacity { state.units[index].status = UnitStatus::Blocked { reason: BlockedReason::Capacity { pool: pool.clone() } }; continue; }
            }
            if unit.input.is_null() {
                let definition = unit_definition(program, state, &unit)?;
                let parent = state.units.iter().find(|u| Some(&u.id) == unit.parent.as_ref()).ok_or_else(|| invalid("parent absent"))?;
                state.units[index].input = eval_record(&definition.input, parent, state, None).ok_or_else(|| invalid("unit input unresolved"))?;
            }
            state.units[index].status = UnitStatus::Active;
            if unit.stage.is_none() { materialize_group(program, state, &unit.id)?; }
            return Ok(true);
        }
        Ok(false)
    }
    /// Pure reducer and bounded internal Start/Complete fixpoint. The snapshot carries
    /// the affected unit, its ancestors, and the evidence required by those units.
    pub fn step(program: &CheckedWorkflow, snapshot: &ScopedSnapshot, incoming: &Incoming) -> Result<StepResult, StepError> {
        let mut state = snapshot.clone();
        reduce(program, &mut state, incoming)?;
        if !matches!(state.run.status, UnitStatus::Cancelled) {
            let bound = state.units.len().saturating_mul(4).saturating_add(64);
            for _ in 0..bound { if !advance(program, &mut state)? { break; } }
            if let Some(root) = state.units.iter().find(|u| u.id == state.run.root) { state.run.status = root.status.clone(); }
        }
        let mut wanted = Vec::new();
        let active: Vec<_> = state.units.iter().filter(|u| u.stage.is_some() && matches!(u.status, UnitStatus::Active)).cloned().collect();
        for unit in active {
            let actions = stage_actions(program, &state, &unit)?;
            for action in &actions {
                if let Action::RunWorker { unit, worker, mode, cause } = action {
                    let id = action_id(unit, worker, mode, cause);
                    if !state.attempts.iter().any(|a| a.action_id == id) {
                        state.attempts.push(AttemptState { action_id: id, seq: 1, unit: unit.clone(), worker: worker.clone(), mode: mode.clone(), cause: cause.clone(), status: AttemptStatus::Pending, kbbl_session_id: None, ended_at: None });
                    }
                }
            }
            wanted.push((unit.id, actions));
        }
        let statuses = state.units.iter().map(|u| (u.id.clone(), u.status.clone())).collect();
        Ok(StepResult { snapshot: state, statuses, wanted })
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn program() -> CheckedWorkflow {
            let source: Workflow = serde_json::from_value(serde_json::json!({
                "workflow":"simple", "input":{}, "run":{"units":{"document":{"stage":"document","input":{}}},"outcome":{"draft":"document.outcome.draft"}},
                "stages":{"document":{"input":{},"artifacts":{"draft":{"schema":"text"}},"workers":{"writer":{"kind":"agent","prompts":{"initial":"write.md"},"inputs":{},"creates":["draft"]}},"done_when":"approved(draft)","outcome":{"draft":"latest(draft)"}}}
            })).unwrap();
            CheckedWorkflow { source, digest: BundleDigest("test".into()), stages: vec![], root: CheckedGroup { units: vec![], outcome: vec![] } }
        }
        fn snapshot() -> ScopedSnapshot {
            ScopedSnapshot { run: RunState { id: "run".into(), root: UnitId::from("run"), status: UnitStatus::NotStarted, input: None }, units: vec![], attempts: vec![], revisions: vec![], decisions: vec![], retry_events: vec![] }
        }
        fn incoming(event: Event, id: &str) -> Incoming { Incoming { event, writer: Writer::Engine, ingress_id: Some(id.into()) } }
        #[test]
        fn failed_attempt_stalls_until_retry_and_duplicates_change_nothing() {
            let program = program();
            let launched = step(&program, &snapshot(), &incoming(Event::Launched { input: serde_json::json!({}) }, "launch")).unwrap();
            assert_eq!(launched.wanted.len(), 1);
            let attempt = launched.snapshot.attempts[0].action_id.clone();
            let started = step(&program, &launched.snapshot, &incoming(Event::WorkerStarted { action: attempt.clone(), kbbl_session_id: Some("session".into()) }, "start")).unwrap();
            let ended = step(&program, &started.snapshot, &incoming(Event::WorkerEnded { action: attempt.clone(), result: WorkerResult::Failed { code: "oops".into(), detail: "failed".into() } }, "end")).unwrap();
            assert!(ended.wanted[0].1.is_empty());
            let duplicate = step(&program, &ended.snapshot, &incoming(Event::WorkerEnded { action: attempt, result: WorkerResult::Failed { code: "oops".into(), detail: "failed".into() } }, "end")).unwrap();
            assert_eq!(duplicate.snapshot, ended.snapshot);
            let retry = step(&program, &ended.snapshot, &incoming(Event::RetryRequested { unit: UnitId::from("run/document"), worker: WorkerKey::from("writer") }, "retry")).unwrap();
            assert_eq!(retry.wanted[0].1.len(), 1);
            assert_eq!(retry.snapshot.attempts.len(), 2);
        }
    }
}
pub use v2_step::step;
pub use collections::materialize;
use std::collections::BTreeSet;
use workflow_compiler::validate_checked_value;
use workflow_model::*;
fn failure(
    kind: DomainErrorKind,
    entity: impl Into<String>,
    detail: impl Into<String>,
) -> DomainError {
    let mut e = DomainError::new(kind, entity, detail);
    e.operation = "evaluate".into();
    e
}
pub(crate) fn owner<'a>(
    program: &'a CheckedProgram,
    snapshot: &Snapshot,
) -> CoreResult<(&'a ScopeDefinition, &'a CheckedScope)> {
    let source = program
        .derived
        .scopes
        .iter()
        .find(|s| s.key == snapshot.scope)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                snapshot.scope.to_string(),
                "scope not compiled",
            )
        })?;
    let checked = program
        .scopes
        .iter()
        .find(|s| s.key == snapshot.scope)
        .ok_or_else(|| {
            failure(
                DomainErrorKind::MissingSymbol,
                snapshot.scope.to_string(),
                "checked scope unavailable",
            )
        })?;
    Ok((source, checked))
}
/// Validation walks every value the snapshot carries, and the observation
/// uniqueness checks compare each root against its predecessors, so both are
/// charged to the evaluation budget before the work is done.
pub(crate) fn snapshot_valid(
    program: &CheckedProgram,
    snapshot: &Snapshot,
    budget: &mut usize,
) -> CoreResult<()> {
    let entity = snapshot.owner.0.as_str();
    let carried = [&snapshot.input, &snapshot.state, &snapshot.trigger.payload]
        .into_iter()
        .chain(snapshot.observations.iter().map(|o| &o.value))
        .fold(0usize, |cost, value| {
            cost.saturating_add(expressions::value_cost(value))
        });
    expressions::charge(budget, carried, entity)?;
    expressions::charge(
        budget,
        snapshot
            .observations
            .len()
            .saturating_mul(snapshot.observations.len()),
        entity,
    )?;
    let maximum = wire_numbers::MAX_SAFE_INTEGER as u64;
    if snapshot.version > maximum
        || snapshot.random_seed > maximum
        || !(wire_numbers::MIN_SAFE_INTEGER..=wire_numbers::MAX_SAFE_INTEGER)
            .contains(&snapshot.timestamp_ms)
        || snapshot
            .observations
            .iter()
            .any(|observation| observation.version > maximum)
    {
        return Err(failure(
            DomainErrorKind::InvalidSnapshot,
            snapshot.owner.to_string(),
            "snapshot metadata exceeds JavaScript-safe wire range",
        ));
    }
    let (scope, _) = owner(program, snapshot)?;
    validate_checked_value(&program.derived, &scope.input_schema, &snapshot.input)?;
    validate_checked_value(&program.derived, &scope.state_schema, &snapshot.state)?;
    if snapshot.owner.0.is_empty() || snapshot.trigger.id.0.is_empty() {
        return Err(failure(
            DomainErrorKind::InvalidSnapshot,
            snapshot.scope.to_string(),
            "owner and trigger identities required",
        ));
    }
    let payload_schema = scope
        .commands
        .iter()
        .find(|c| c.key == snapshot.trigger.key)
        .map(|c| &c.payload_schema)
        .or_else(|| {
            scope
                .facts
                .iter()
                .find(|f| f.key == snapshot.trigger.key)
                .map(|f| &f.payload_schema)
        })
        .ok_or_else(|| {
            failure(
                DomainErrorKind::UndeclaredTrigger,
                snapshot.trigger.key.to_string(),
                "event belongs to another scope or is undeclared",
            )
        })?;
    validate_checked_value(&program.derived, payload_schema, &snapshot.trigger.payload)?;
    let mut identities = BTreeSet::new();
    let mut roots = Vec::new();
    for observation in &snapshot.observations {
        if observation.identity == snapshot.owner.0
            || observation.identity.is_empty()
            || !identities.insert(&observation.identity)
            || roots.contains(&observation.root)
        {
            return Err(failure(
                DomainErrorKind::InvalidSnapshot,
                snapshot.owner.to_string(),
                "duplicate observed identity or root",
            ));
        }
        roots.push(observation.root.clone());
        let expected = match &observation.root {
            ReferenceRoot::Output { key } => scope
                .outputs
                .iter()
                .find(|x| x.key == *key)
                .map(|x| &x.schema),
            ReferenceRoot::Resource { key } => scope
                .resources
                .iter()
                .find(|x| x.key == *key)
                .map(|x| &x.schema),
            ReferenceRoot::Result { worker } => scope
                .workers
                .iter()
                .find(|x| x.key == *worker)
                .map(|x| &x.result_schema),
            ReferenceRoot::Child { key, export } => scope
                .children
                .iter()
                .find(|c| c.key == *key && c.imports.contains(export))
                .and_then(|c| program.derived.scopes.iter().find(|s| s.key == c.scope))
                .and_then(|s| s.exports.iter().find(|e| e.key == *export))
                .map(|e| &e.schema),
            ReferenceRoot::OutputCollection { schema, .. }
            | ReferenceRoot::OutputRevisions { schema, .. }
            | ReferenceRoot::OutputRevision { schema, .. }
            | ReferenceRoot::OptionalOutputRevision { schema, .. }
            | ReferenceRoot::Children { schema, .. }
            | ReferenceRoot::ChildrenOutcomes { schema, .. }
            | ReferenceRoot::ChildrenComplete { schema, .. } => {
                workflow_compiler::validate_observation_root(
                    &program.derived,
                    scope,
                    &observation.root,
                )?;
                Some(schema)
            }
            _ => None,
        }
        .ok_or_else(|| {
            failure(
                DomainErrorKind::PrivateRead,
                snapshot.owner.to_string(),
                "undeclared or private observed root",
            )
        })?;
        validate_checked_value(&program.derived, expected, &observation.value)?;
    }
    Ok(())
}
pub fn evaluate(program: &CheckedProgram, snapshot: &Snapshot) -> CoreResult<DecisionOutcome> {
    let mut budget = program.derived.limits.evaluation_budget;
    snapshot_valid(program, snapshot, &mut budget)?;
    let (scope, checked) = owner(program, snapshot)?;
    let state = expressions::variant(&snapshot.state)?;
    let mut read_set = vec![ReadVersion {
        identity: snapshot.owner.0.clone(),
        version: snapshot.version,
    }];
    read_set.extend(snapshot.observations.iter().map(|o| ReadVersion {
        identity: o.identity.clone(),
        version: o.version,
    }));
    read_set.sort_by(|a, b| a.identity.cmp(&b.identity));
    let mut explanation = Explanation {
        bundle_digest: program.digest.clone(),
        owner: snapshot.owner.clone(),
        node_id: NodeId("".into()),
        trigger_id: snapshot.trigger.id.clone(),
        read_set,
        trace: Vec::new(),
    };
    if let Some(command) = scope
        .commands
        .iter()
        .find(|c| c.key == snapshot.trigger.key)
    {
        if !command.available_in.contains(&state) {
            return Err(failure(
                DomainErrorKind::UndeclaredTrigger,
                command.key.to_string(),
                "command unavailable in committed state",
            ));
        }
    }
    let mut node = &checked.tree;
    loop {
        if budget == 0 {
            return Err(failure(
                DomainErrorKind::ResourceLimit,
                snapshot.owner.to_string(),
                "evaluation budget exhausted; no workflow transition",
            ));
        }
        budget -= 1;
        let id = match node {
            CheckedTree::Match { id, .. }
            | CheckedTree::If { id, .. }
            | CheckedTree::Apply { id, .. }
            | CheckedTree::Wait { id, .. }
            | CheckedTree::Reject { id, .. } => id,
        };
        explanation.node_id = id.clone();
        explanation.trace.push(id.0.clone());
        let mut context = expressions::EvaluationContext {
            program,
            snapshot,
            item: None,
            budget: &mut budget,
        };
        match node {
            CheckedTree::Match {
                value,
                cases,
                otherwise,
                ..
            } => {
                let value = expressions::evaluate_expression(value, &mut context)?;
                let choice = expressions::variant(&value)?;
                node = if let Some(case) = cases.iter().find(|c| c.variant == choice) {
                    &case.node
                } else {
                    otherwise.as_deref().ok_or_else(|| {
                        failure(
                            DomainErrorKind::InvalidSnapshot,
                            id.to_string(),
                            "checked match has no branch",
                        )
                    })?
                };
            }
            CheckedTree::If {
                condition,
                then,
                otherwise,
                ..
            } => {
                node = if expressions::boolean(&expressions::evaluate_expression(
                    condition,
                    &mut context,
                )?)? {
                    then
                } else {
                    otherwise
                };
            }
            CheckedTree::Wait {
                continuations,
                reason,
                attention,
                ..
            } => {
                return Ok(DecisionOutcome::Wait {
                    explanation,
                    continuations: continuations.clone(),
                    reason: reason.clone(),
                    attention: Some(attention.clone()),
                })
            }
            CheckedTree::Reject { error, detail, .. } => {
                return Ok(DecisionOutcome::Reject {
                    explanation,
                    error: error.clone(),
                    detail: detail.clone(),
                })
            }
            CheckedTree::Apply {
                mutations,
                actions,
                outcome,
                ..
            } => {
                let mut selected = Vec::new();
                for mutation in mutations {
                    selected.push(match mutation {
                        CheckedMutation::SetState { value } => MutationValue::SetState {
                            value: expressions::evaluate_expression(value, &mut context)?,
                        },
                        CheckedMutation::Export { key, value } => MutationValue::Export {
                            key: key.clone(),
                            value: expressions::evaluate_expression(value, &mut context)?,
                        },
                        CheckedMutation::ActivateChild { key } => {
                            let child =
                                checked.children.iter().find(|c| c.key == *key).ok_or_else(
                                    || {
                                        failure(
                                            DomainErrorKind::MissingSymbol,
                                            key.to_string(),
                                            "checked child missing",
                                        )
                                    },
                                )?;
                            if child.collection.is_some() {
                                selected.push(MutationValue::ActivateCollection {
                                    key: key.clone(),
                                    materialization: collections::materialize_with_budget(
                                        program,
                                        snapshot,
                                        key,
                                        context.budget,
                                    )?,
                                });
                                continue;
                            }
                            MutationValue::ActivateChild {
                                key: key.clone(),
                                input: expressions::evaluate_expression(
                                    &child.input,
                                    &mut context,
                                )?,
                            }
                        }
                        CheckedMutation::ClearOutput { key } => {
                            MutationValue::ClearOutput { key: key.clone() }
                        }
                        CheckedMutation::CancelChildren { key } => {
                            MutationValue::CancelChildren { key: key.clone() }
                        }
                        CheckedMutation::Acquire { pool } => {
                            MutationValue::Acquire { pool: pool.clone() }
                        }
                        CheckedMutation::Release { pool } => {
                            MutationValue::Release { pool: pool.clone() }
                        }
                        CheckedMutation::Revoke { worker } => MutationValue::Revoke {
                            worker: worker.clone(),
                        },
                        CheckedMutation::Stop { worker } => MutationValue::Stop {
                            worker: worker.clone(),
                        },
                        CheckedMutation::BindResource { key, value } => {
                            MutationValue::BindResource {
                                key: key.clone(),
                                value: expressions::evaluate_expression(value, &mut context)?,
                            }
                        }
                        CheckedMutation::ClearResource { key } => {
                            MutationValue::ClearResource { key: key.clone() }
                        }
                        CheckedMutation::Observe { resource } => MutationValue::Observe {
                            resource: resource.clone(),
                        },
                    });
                }
                let invocations: Vec<Invocation> = actions
                    .iter()
                    .map(|a| {
                        Ok(Invocation {
                            selection: a.selection.clone(),
                            definition: a.definition.clone(),
                            input: expressions::evaluate_expression(&a.input, &mut context)?,
                            prompt_key: a.prompt_key.clone(),
                        })
                    })
                    .collect::<CoreResult<_>>()?;
                let outcome = outcome
                    .as_ref()
                    .map(|e| expressions::evaluate_expression(e, &mut context))
                    .transpose()?;
                let targets = checked
                    .command_targets
                    .iter()
                    .find(|c| c.command == snapshot.trigger.key)
                    .map(|c| {
                        c.targets
                            .iter()
                            .map(|e| expressions::evaluate_expression(e, &mut context))
                            .collect::<CoreResult<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                if !selected.is_empty()
                    && outcome.is_none()
                    && invocations.is_empty()
                    && selected
                        .iter()
                        .all(|mutation| matches!(mutation, MutationValue::SetState { .. }))
                {
                    let mut is_unchanged = true;
                    for mutation in &selected {
                        let MutationValue::SetState { value } = mutation else {
                            unreachable!()
                        };
                        if !expressions::equal_values(value, &snapshot.state, context.budget)? {
                            is_unchanged = false;
                        }
                    }
                    if is_unchanged {
                        return Ok(DecisionOutcome::Wait {
                            explanation,
                            continuations: vec![snapshot.trigger.key.clone()],
                            reason: "unchanged state; awaiting a new trigger".into(),
                            attention: None,
                        });
                    }
                }
                if selected.is_empty() && outcome.is_none() && actions.is_empty() {
                    return Ok(DecisionOutcome::Wait {
                        explanation,
                        continuations: vec![snapshot.trigger.key.clone()],
                        reason: "mutation-free leaf; no commit required".into(),
                        attention: None,
                    });
                }
                return Ok(DecisionOutcome::Apply {
                    explanation,
                    mutations: selected,
                    invocations,
                    outcome,
                    targets,
                });
            }
        }
    }
}
