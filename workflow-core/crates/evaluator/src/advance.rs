use super::*;
pub(super) fn materialize_group(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    group_id: &UnitId,
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<Delta>, StepError> {
    let mut state = snapshot.clone();
    let mut deltas = Vec::new();
    let parent = state
        .units
        .iter()
        .find(|u| u.id == *group_id)
        .cloned()
        .ok_or_else(|| invalid("group absent"))?;
    let group = group_for(program, &state, &parent)?.clone();
    let mut units = group.units.iter().collect::<Vec<_>>();
    units.sort_by_key(|unit| &unit.key);
    for unit in units {
        let key = &unit.key.0;
        let collection = unit.collection.clone();
        let each_values = if let Some(collection) = &collection {
            eval_expression(
                &collection.source.expression,
                &parent,
                &state,
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
                    &state,
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
                        &state,
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
                Some(
                    eval_fields(declared_input, &parent, &state, Some(each), context)?
                        .ok_or_else(|| rejected("collection input unresolved"))?,
                )
            } else {
                None
            };
            let delta = Delta::PushUnit(UnitState {
                id: UnitId(format!("{group_id}/{member}")),
                parent: Some(group_id.clone()),
                declaration: SymbolKey::from(key.as_str()),
                kind: match &unit.stage {
                    Some(stage) => UnitKind::Stage(stage.clone()),
                    None => UnitKind::Group,
                },
                collection_key: collection.as_ref().map(|_| member.clone()),
                status: UnitStatus::NotStarted,
                input,
                after: dependencies
                    .into_iter()
                    .map(|d| UnitId(format!("{group_id}/{d}")))
                    .collect(),
                pool: unit.pool.clone(),
            });
            apply(&mut state, context, delta.clone());
            deltas.push(delta);
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
    Ok(deltas)
}
pub(super) fn group_outcome(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    context: &mut EvaluationContext<'_>,
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
pub(super) fn start_group(
    program: &CheckedWorkflow,
    snapshot: &StepSnapshot,
    group_id: &UnitId,
    context: &mut EvaluationContext<'_>,
) -> Result<Vec<Delta>, StepError> {
    let mut state = snapshot.clone();
    let mut deltas = materialize_group(program, &state, group_id, context)?;
    apply_all(&mut state, context, deltas.clone());
    if state
        .units
        .iter()
        .any(|unit| unit.parent.as_ref() == Some(group_id))
    {
        return Ok(deltas);
    }
    let index = state
        .units
        .iter()
        .position(|unit| unit.id == *group_id)
        .ok_or_else(|| invalid("group absent"))?;
    let outcome = group_outcome(program, &state, &state.units[index], context)?;
    deltas.push(Delta::UnitStatus {
        index,
        status: UnitStatus::Done { outcome },
    });
    Ok(deltas)
}
pub(super) fn engine_decision(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    unit: &UnitState,
    unobserved: &[SymbolKey],
    context: &mut EvaluationContext<'_>,
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
        let effect = match decision.effect {
            DeclaredDecisionEffect::Approve => DecisionEffect::Approve,
            DeclaredDecisionEffect::RequestChanges => DecisionEffect::RequestChanges {
                feedback: decision.feedback.clone(),
            },
        };
        return Ok(Some(DecisionState::Review {
            id: decision_id(state, &unit.id),
            unit: unit.id.clone(),
            review: key.clone(),
            decision: decision.key.clone(),
            effect,
            target: target.id.clone(),
            payload: serde_json::json!({ "feedback": decision.feedback }),
        }));
    }
    Ok(None)
}
/// Active units to revisit before selecting the next candidate. Activating a
/// stage changes only that stage's evidence; a completion or decision may
/// affect earlier units, so those moves restart the full scan.
#[derive(Clone, Copy)]
pub(super) enum ActiveScan {
    All,
    Unit(usize),
}

pub(super) fn active_scan_after_move(state: &StepSnapshot, deltas: &[Delta]) -> ActiveScan {
    for delta in deltas {
        if let Delta::UnitStatus {
            index,
            status: UnitStatus::Active,
        } = delta
        {
            if state.units[*index].kind.stage().is_some() {
                return ActiveScan::Unit(*index);
            }
        }
    }
    ActiveScan::All
}

/// Return one observable move. The caller applies it and repeats until there is
/// no move left. Active units keep their snapshot order; candidates use ID order.
pub(super) fn next_move(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
    context: &mut EvaluationContext<'_>,
    active_scan: ActiveScan,
) -> Result<Option<Vec<Delta>>, StepError> {
    for (index, unit) in state.units.iter().enumerate() {
        if !match active_scan {
            ActiveScan::All => true,
            ActiveScan::Unit(only) => index == only,
        } {
            continue;
        }
        if !matches!(unit.status, UnitStatus::Active) {
            continue;
        }
        let move_for_unit = (|| -> Result<Option<Vec<Delta>>, StepError> {
            if unit.kind.stage().is_some() {
                let definition = checked_stage(program, unit)?;
                let unobserved = unobserved_watch_artifacts(program, state, unit, context)?;
                let reads_unobserved = reads_any(&definition.done_when.expression, &unobserved)
                    || definition
                        .outcome
                        .iter()
                        .any(|field| reads_any(&field.value.expression, &unobserved));
                if !reads_unobserved
                    && eval_expression(
                        &definition.done_when.expression,
                        unit,
                        state,
                        None,
                        None,
                        context,
                    )? == Some(Value::Bool(true))
                {
                    let outcome = eval_fields(&definition.outcome, unit, state, None, context)?
                        .ok_or_else(|| invalid("stage outcome unresolved"))?;
                    return Ok(Some(vec![Delta::UnitStatus {
                        index,
                        status: UnitStatus::Done { outcome },
                    }]));
                }
                if let Some(decision) = engine_decision(program, state, unit, &unobserved, context)?
                {
                    return Ok(Some(vec![Delta::PushDecision(decision)]));
                }
                return Ok(None);
            }
            let children: Vec<_> = state
                .units
                .iter()
                .filter(|child| child.parent.as_ref() == Some(&unit.id))
                .collect();
            if !children.is_empty()
                && children
                    .iter()
                    .all(|child| matches!(child.status, UnitStatus::Done { .. }))
            {
                let outcome = group_outcome(program, state, unit, context)?;
                return Ok(Some(vec![Delta::UnitStatus {
                    index,
                    status: UnitStatus::Done { outcome },
                }]));
            }
            Ok(None)
        })()
        .map_err(advancing(&unit.id))?;
        if move_for_unit.is_some() {
            return Ok(move_for_unit);
        }
    }

    let mut candidates: Vec<_> = state
        .units
        .iter()
        .enumerate()
        .filter(|(_, unit)| matches!(unit.status, UnitStatus::NotStarted))
        .collect();
    candidates.sort_by_key(|(_, unit)| unit.id.clone());
    for (index, unit) in candidates {
        let move_for_unit = (|| -> Result<Option<Vec<Delta>>, StepError> {
            let waiting: Vec<_> = unit
                .after
                .iter()
                .filter(|dep| {
                    !state.units.iter().any(|candidate| {
                        candidate.id == **dep && matches!(candidate.status, UnitStatus::Done { .. })
                    })
                })
                .cloned()
                .collect();
            if !waiting.is_empty() {
                return Ok(None);
            }
            if let Some(pool) = &unit.pool {
                let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("pooled root"))?;
                let parent = state
                    .units
                    .iter()
                    .find(|candidate| candidate.id == *parent_id)
                    .ok_or_else(|| invalid("pool owner absent"))?;
                let capacity = *group_for(program, state, parent)?
                    .pools
                    .get(&pool.0)
                    .ok_or_else(|| invalid("pool absent"))? as usize;
                let held = state
                    .units
                    .iter()
                    .filter(|candidate| {
                        candidate.parent.as_ref() == Some(parent_id)
                            && candidate.pool.as_ref() == Some(pool)
                            && matches!(candidate.status, UnitStatus::Active)
                    })
                    .count();
                if held >= capacity {
                    return Ok(None);
                }
            }
            let mut deltas = Vec::new();
            if unit.input.is_none() {
                let parent = state
                    .units
                    .iter()
                    .find(|candidate| Some(&candidate.id) == unit.parent.as_ref())
                    .ok_or_else(|| invalid("parent absent"))?;
                let declared =
                    checked_unit(group_for(program, state, parent)?, &unit.declaration.0)?;
                let input = eval_fields(&declared.input, parent, state, None, context)?
                    .ok_or_else(|| invalid("unit input unresolved"))?;
                deltas.push(Delta::UnitInput { index, input });
            }
            deltas.push(Delta::UnitStatus {
                index,
                status: UnitStatus::Active,
            });
            if unit.kind.stage().is_none() {
                let mut state_after = state.clone();
                apply_all(&mut state_after, context, deltas.clone());
                deltas.extend(start_group(program, &state_after, &unit.id, context)?);
            }
            Ok(Some(deltas))
        })()
        .map_err(advancing(&unit.id))?;
        if move_for_unit.is_some() {
            return Ok(move_for_unit);
        }
    }
    Ok(None)
}

/// Blocked-ness is a per-step read; it is never a stored unit status.
pub(super) fn blocked_units(
    program: &CheckedWorkflow,
    state: &StepSnapshot,
) -> Result<Vec<UnitBlock>, StepError> {
    state
        .units
        .iter()
        .filter(|unit| matches!(unit.status, UnitStatus::NotStarted))
        .map(|unit| {
            let waiting: Vec<_> = unit
                .after
                .iter()
                .filter(|dep| {
                    !state.units.iter().any(|candidate| {
                        candidate.id == **dep && matches!(candidate.status, UnitStatus::Done { .. })
                    })
                })
                .cloned()
                .collect();
            if !waiting.is_empty() {
                return Ok(Some(UnitBlock {
                    unit: unit.id.clone(),
                    reason: BlockedReason::WaitingOn { units: waiting },
                }));
            }
            let Some(pool) = &unit.pool else {
                return Ok(None);
            };
            let parent_id = unit.parent.as_ref().ok_or_else(|| invalid("pooled root"))?;
            let parent = state
                .units
                .iter()
                .find(|candidate| candidate.id == *parent_id)
                .ok_or_else(|| invalid("pool owner absent"))?;
            let capacity = *group_for(program, state, parent)?
                .pools
                .get(&pool.0)
                .ok_or_else(|| invalid("pool absent"))? as usize;
            let held = state
                .units
                .iter()
                .filter(|candidate| {
                    candidate.parent.as_ref() == Some(parent_id)
                        && candidate.pool.as_ref() == Some(pool)
                        && matches!(candidate.status, UnitStatus::Active)
                })
                .count();
            Ok((held >= capacity).then(|| UnitBlock {
                unit: unit.id.clone(),
                reason: BlockedReason::Capacity { pool: pool.clone() },
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|blocks| blocks.into_iter().flatten().collect())
}
