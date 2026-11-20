use super::*;

pub(super) fn is_adjudicating(review: &Review) -> bool {
    review
        .decisions
        .values()
        .any(|decision| decision.adjudication.is_some())
}

pub(super) fn reviews_assessment(review: &Review, artifacts: &BTreeMap<String, Artifact>) -> bool {
    artifacts
        .get(&review.of.0)
        .is_some_and(|artifact| artifact.kind == ArtifactKind::Assessment)
}

pub(super) struct AdjudicationCheck<'a> {
    pub review_key: &'a str,
    pub review: &'a Review,
    pub stage_key: &'a str,
    pub stage: &'a Stage,
    pub path: &'a str,
}

pub(super) fn check_adjudication(input: AdjudicationCheck<'_>) -> Vec<CompileError> {
    let AdjudicationCheck {
        review_key,
        review,
        stage_key,
        stage,
        path,
    } = input;
    let is_adjudicating = is_adjudicating(review);
    let mut errors = Vec::new();
    if !is_adjudicating && review.assessment.is_none() {
        return errors;
    }
    let mut report = |path, detail| {
        errors.push(CompileError::new(
            CheckKind::Review,
            path,
            SourceSpan::default(),
            detail,
        ));
    };

    let mut has_feedback = false;
    for (key, decision) in &review.decisions {
        let decision_path = format!("{path}.decisions.{key}");
        let role_path = format!("{decision_path}.adjudication");
        if is_adjudicating
            && decision.effect == DeclaredDecisionEffect::Approve
            && decision.adjudication != Some(AdjudicationRole::Accept)
        {
            report(
                role_path.clone(),
                format!("approve decision {key} on adjudicating review {review_key} must be adjudication accept"),
            );
        }
        let Some(role) = decision.adjudication else {
            continue;
        };
        if review.by == ReviewBy::Engine {
            report(
                role_path.clone(),
                format!("engine review {review_key} cannot declare adjudication"),
            );
        }
        let (required_effect, effect_name, role_name) = match role {
            AdjudicationRole::Accept => (DeclaredDecisionEffect::Approve, "approve", "accept"),
            AdjudicationRole::Feedback => (
                DeclaredDecisionEffect::RequestChanges,
                "request_changes",
                "feedback",
            ),
        };
        if decision.effect != required_effect {
            report(
                role_path.clone(),
                format!("adjudication {role_name} requires effect {effect_name}"),
            );
        }
        if decision.payload.is_none() {
            report(
                format!("{decision_path}.payload"),
                format!("adjudication decision {key} requires a payload"),
            );
        }
        if role == AdjudicationRole::Feedback {
            if decision.feedback_field.is_none() {
                report(
                    format!("{decision_path}.feedback_field"),
                    format!("feedback decision {key} requires feedback_field"),
                );
            }
            if has_feedback {
                report(
                    role_path,
                    format!("review {review_key} has more than one feedback decision"),
                );
            }
            has_feedback = true;
        }
    }

    let of_is_assessment = reviews_assessment(review, &stage.artifacts);
    if let Some(assessment) = &review.assessment {
        let assessment_path = format!("{path}.assessment");
        if !is_adjudicating {
            report(
                assessment_path.clone(),
                "assessment is only allowed on an adjudicating review".into(),
            );
        }
        match stage.artifacts.get(&assessment.0) {
            None => report(
                assessment_path.clone(),
                format!("assessment {assessment} is not an artifact of stage {stage_key}"),
            ),
            Some(artifact) if artifact.kind != ArtifactKind::Assessment => report(
                assessment_path.clone(),
                format!("assessment {assessment} is not a kind: assessment artifact"),
            ),
            Some(_) => {}
        }
        if of_is_assessment && assessment != &review.of {
            report(
                assessment_path,
                format!(
                    "assessment {assessment} differs from reviewed assessment {}",
                    review.of
                ),
            );
        }
    } else if is_adjudicating && !of_is_assessment {
        report(
            path.into(),
            format!("adjudicating review {review_key} must declare assessment"),
        );
    }
    errors
}
