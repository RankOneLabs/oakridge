use super::*;

fn is_assessment(stage: &Stage, key: &SymbolKey) -> bool {
    stage
        .artifacts
        .get(&key.0)
        .is_some_and(|artifact| artifact.kind == ArtifactKind::Assessment)
}

fn assessment_artifact<'a>(stage: &Stage, review: &'a Review) -> Option<&'a SymbolKey> {
    review
        .assessment
        .as_ref()
        .or_else(|| is_assessment(stage, &review.of).then_some(&review.of))
}

pub fn assessment_embeddings(
    workflow: &Workflow,
) -> BTreeMap<SymbolKey, BTreeMap<SymbolKey, AssessmentEmbeddings>> {
    workflow
        .stages
        .iter()
        .filter_map(|(key, stage)| {
            let assessments = stage_embeddings(stage, &workflow.schemas);
            (!assessments.is_empty()).then(|| (SymbolKey::from(key.as_str()), assessments))
        })
        .collect()
}

fn stage_embeddings(
    stage: &Stage,
    schemas: &BTreeMap<String, Type>,
) -> BTreeMap<SymbolKey, AssessmentEmbeddings> {
    stage
        .artifacts
        .iter()
        .filter(|(_, artifact)| artifact.kind == ArtifactKind::Assessment)
        .map(|(key, artifact)| {
            let mut found = AssessmentEmbeddings {
                proposals: Vec::new(),
                verifications: Vec::new(),
            };
            walk(
                &artifact.schema,
                schemas,
                &mut BTreeSet::new(),
                &mut Vec::new(),
                &mut found,
            );
            (SymbolKey::from(key.as_str()), found)
        })
        .collect()
}

fn walk(
    ty: &Type,
    schemas: &BTreeMap<String, Type>,
    active: &mut BTreeSet<String>,
    path: &mut Vec<PathSegment>,
    found: &mut AssessmentEmbeddings,
) {
    match ty {
        Type::Named { schema } if schema.0 == "feedback_proposal" => {
            found.proposals.push(path.clone())
        }
        Type::Named { schema } if schema.0 == "assignment_verification" => {
            found.verifications.push(path.clone())
        }
        Type::Named { schema } => {
            if let Some(ty) = schemas.get(&schema.0) {
                if active.insert(schema.0.clone()) {
                    walk(ty, schemas, active, path, found);
                    active.remove(&schema.0);
                }
            }
        }
        Type::Record { fields } => {
            for (field, ty) in fields {
                path.push(PathSegment::Field(field.clone()));
                walk(ty, schemas, active, path, found);
                path.pop();
            }
        }
        Type::List { item } => {
            path.push(PathSegment::Each);
            walk(item, schemas, active, path, found);
            path.pop();
        }
        Type::Optional { value } => walk(value, schemas, active, path, found),
        _ => {}
    }
}

pub(super) fn check(workflow: &Workflow) -> Vec<CompileError> {
    let mut errors = Vec::new();
    let mut report = |path, detail| {
        errors.push(CompileError::new(
            CheckKind::Review,
            path,
            SourceSpan::default(),
            detail,
        ));
    };
    for (stage_key, stage) in &workflow.stages {
        for (review_key, review) in &stage.reviews {
            let path = format!("stages.{stage_key}.reviews.{review_key}");
            let assessment = assessment_artifact(stage, review);
            if let Some(assessment) = &review.assessment {
                if review.by != ReviewBy::Operator
                    || review
                        .decisions
                        .values()
                        .all(|decision| decision.operation.is_plain())
                {
                    report(
                        format!("{path}.assessment"),
                        "assessment requires an operator review with an assessment operation"
                            .into(),
                    );
                }
                if !is_assessment(stage, assessment) {
                    report(format!("{path}.assessment"), format!("assessment {assessment} is not a kind: assessment artifact of stage {stage_key}"));
                }
                if is_assessment(stage, &review.of) && assessment != &review.of {
                    report(
                        format!("{path}.assessment"),
                        format!(
                            "assessment {assessment} differs from reviewed assessment {}",
                            review.of
                        ),
                    );
                }
            }
            let mut operations = BTreeSet::new();
            for (key, decision) in &review.decisions {
                let decision_path = format!("{path}.decisions.{key}");
                if (assessment.is_some() || is_assessment(stage, &review.of))
                    && decision.payload.is_some()
                {
                    report(
                        format!("{decision_path}.payload"),
                        "assessment decisions carry no payload; declare an operation".into(),
                    );
                }
                let operation = decision.operation;
                if operation.is_plain() {
                    continue;
                }
                let operation_path = format!("{decision_path}.operation");
                let operation_name = match operation {
                    DecisionOperation::ApproveAssessment => "approve_assessment",
                    DecisionOperation::DispatchFeedback => "dispatch_feedback",
                    DecisionOperation::DirectCorrection => "direct_correction",
                    DecisionOperation::Plain => unreachable!(),
                };
                let is_approval = operation == DecisionOperation::ApproveAssessment;
                let (effect, effect_name) = if is_approval {
                    (DeclaredDecisionEffect::Approve, "approve")
                } else {
                    (DeclaredDecisionEffect::RequestChanges, "request_changes")
                };
                if decision.effect != effect {
                    report(
                        operation_path.clone(),
                        format!("{operation_name} requires effect {effect_name}"),
                    );
                }
                if review.by != ReviewBy::Operator
                    || !assessment.is_some_and(|key| is_assessment(stage, key))
                {
                    report(
                        operation_path.clone(),
                        format!("{operation_name} requires an operator review of an assessment"),
                    );
                }
                if !is_approval
                    && !decision
                        .on
                        .as_ref()
                        .is_some_and(|key| stage.artifacts.contains_key(&key.0))
                {
                    report(
                        operation_path.clone(),
                        format!(
                            "{operation_name} requires on to name an artifact of stage {stage_key}"
                        ),
                    );
                }
                if !operations.insert(operation) {
                    report(
                        operation_path,
                        format!("review {review_key} declares {operation_name} more than once"),
                    );
                }
            }
        }
        for (artifact, embeddings) in stage_embeddings(stage, &workflow.schemas) {
            let path = format!("stages.{stage_key}.artifacts.{artifact}");
            if embeddings.proposals.is_empty() {
                if !embeddings.verifications.is_empty() {
                    report(
                        path,
                        "assignment_verification requires feedback_proposal in the same assessment"
                            .into(),
                    );
                }
                continue;
            }
            let covered = stage.reviews.values().any(|review| {
                assessment_artifact(stage, review) == Some(&artifact)
                    && [
                        DecisionOperation::ApproveAssessment,
                        DecisionOperation::DispatchFeedback,
                    ]
                    .iter()
                    .all(|operation| {
                        review
                            .decisions
                            .values()
                            .any(|decision| decision.operation == *operation)
                    })
            });
            if !covered {
                report(path, format!("assessment {artifact} embeds feedback_proposal but no review declares approve_assessment and dispatch_feedback"));
            }
        }
    }
    errors
}
