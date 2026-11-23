import { ARTIFACT_KEYS } from "../artifact-versions";
import { err, ok, type JsonValue, type Result } from "../../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type LinkReference, type LogicalItemLink, type SelectedItem } from "../../../projection/extractor";
import { TASK_SCOPE, definition, register, mapped, pathItem, taskItem, topList, type Extractor, type Registration } from "../extractor-helpers";

function referenceId(value: JsonValue, field: string, path: string): Result<string, ExtractionFailure> {
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const id = object.value[field];
  return typeof id === "string" && id.length > 0 ? ok(id)
    : err({ operation: "select_items", entity_id: `${path}/${field}`, detail: "missing reference id" });
}
function proposal(value: JsonValue, path: string): Result<SelectedItem, ExtractionFailure> {
  const key = referenceId(value, "key", path);
  if (!key.ok) return key;
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const citation = object.value.citation;
  const links: LinkReference[] = [];
  if (citation != null) {
    const revision = referenceId(citation, "revision_id", `${path}/citation`);
    if (!revision.ok) return revision;
    const cited = objectAt(citation, `${path}/citation`);
    if (!cited.ok) return cited;
    const { pointer } = cited.value;
    if (typeof pointer !== "string") return err({ operation: "select_items", entity_id: path, detail: "citation pointer is required" });
    links.push({ target: "address", type: "derived_from", revision_id: revision.value, pointer, evidence_ref: `${path}/citation` });
  }
  return ok(pathItem("feedback_proposal", "/proposals/*", path, value, links, key.value));
}
const assessmentFeedback = [
  definition("assessment.proposals", "feedback_proposal", "/proposals/*", topList("proposals", proposal)),
  definition("assessment.verifications", "assignment_verification", "/verifications/*",
    topList("verifications", (value, path) => ok(pathItem("assignment_verification", "/verifications/*", path, value)))),
];
type StudyKind = "case" | "criterion" | "trigger" | "cohort_file";
const isStudyKind = (value: JsonValue | undefined): value is StudyKind =>
  value === "case" || value === "criterion" || value === "trigger" || value === "cohort_file";

interface StudyTaskLinkTarget extends Pick<LogicalItemLink, "type" | "target_local_id" | "evidence_ref"> {
  readonly target_task_kind: StudyKind;
}

function studyTaskLink(target: StudyTaskLinkTarget): LogicalItemLink {
  return { ...target, target: "logical_item", target_scope: TASK_SCOPE };
}
function studySubject(value: JsonValue, path: string, type: LogicalItemLink["type"]): Result<LogicalItemLink, ExtractionFailure> {
  const id = requiredId(value, path);
  if (!id.ok) return id;
  const subject = objectAt(value, path);
  if (!subject.ok) return subject;
  const kind = subject.value.kind;
  return isStudyKind(kind) ? ok(studyTaskLink({ type, target_task_kind: kind, target_local_id: id.value, evidence_ref: path })) :
    err({ operation: "select_items", entity_id: path, detail: "unknown study subject kind" });
}
function studyTask(path: readonly string[], kind: StudyKind): Extractor {
  const field = path.join("/");
  const selector = `/${field}/*`;
  return definition(`study.${kind}`, kind, selector, (body) => {
    const items = listAt(body, path);
    return items.ok ? mapped(items.value, `/${field}`, (value, address) => {
      const id = requiredId(value, address);
      return id.ok ? ok(taskItem(kind, selector, address, id.value, value, [], kind)) : id;
    }) : items;
  });
}
interface StudyMarkFields {
  readonly field: string;
  readonly item_kind: string;
  readonly task_kind: StudyKind;
  readonly idField: string;
}

function studyMark({ field, item_kind, task_kind, idField }: StudyMarkFields): Extractor {
  const selector = `/${field}/*`;
  return definition(`study.${field}`, item_kind, selector, topList(field, (value, address) => {
    const id = referenceId(value, idField, address);
    return id.ok ? ok(pathItem(item_kind, selector, address, value,
      [studyTaskLink({ type: "assesses", target_task_kind: task_kind, target_local_id: id.value, evidence_ref: `${address}/${idField}` })], id.value)) : id;
  }));
}
const study = ARTIFACT_KEYS.study;
function studyRegistrations(): readonly Registration[] {
  const qualifications = studyMark({ field: "qualifications", item_kind: "qualification", task_kind: "case", idField: "case_id" });
  const assessment = [
    definition("assessment.item_assessments", "item_assessment", "/item_assessments/*", topList("item_assessments", (value, path) => {
      const object = objectAt(value, path);
      if (!object.ok) return object;
      const link = studySubject(object.value.subject ?? null, `${path}/subject`, "assesses");
      return link.ok ? ok(pathItem("item_assessment", "/item_assessments/*", path, value, [link.value], link.value.target_local_id)) : link;
    })),
    definition("assessment.additional_findings", "additional_finding", "/additional_findings/*", topList("additional_findings", (value, path) => {
      const id = requiredId(value, path);
      if (!id.ok) return id;
      const subjects = listAt(value, ["related_subjects"]);
      if (!subjects.ok) return subjects;
      const links: LogicalItemLink[] = [];
      for (const [index, subject] of subjects.value.entries()) {
        const link = studySubject(subject, `${path}/related_subjects/${index}`, "addresses");
        if (!link.ok) return link;
        links.push(link.value);
      }
      return ok(pathItem("additional_finding", "/additional_findings/*", path, value, links, id.value));
    })),
    ...assessmentFeedback,
  ];
  return [
    register(study.design.plan, [studyTask(["cases"], "case"), studyTask(["pilot_selection", "criteria"], "criterion"),
      studyTask(["iteration_triggers"], "trigger"), ...[["hypotheses", "hypothesis"], ["outcomes", "outcome"]].map(([field, kind]) => {
        const selector = `/${field}/*`;
        return definition(`plan.${field}`, kind!, selector, topList(field!, (value, path) => ok(pathItem(kind!, selector, path, value))));
      })]),
    register(study.design.slice_build, [qualifications]),
    register(study.expand.expansion, [qualifications]),
    register(study.design.slice_report, [studyMark({ field: "criteria_marks", item_kind: "criterion_mark", task_kind: "criterion", idField: "id" }),
      studyMark({ field: "trigger_marks", item_kind: "trigger_mark", task_kind: "trigger", idField: "id" }), studyMark({ field: "paid_results", item_kind: "paid_result", task_kind: "case", idField: "case_id" })]),
    register(study.design.slice_assessment, assessment),
    register(study.expand.assessment, assessment),
    register(study.integration.assessment, assessment),
    register(study.freeze.freeze, [definition("freeze.cohorts", "cohort_file", "/cohorts/*", topList("cohorts", (value, path) => {
      const id = requiredId(value, path);
      if (!id.ok) return id;
      const cases = idList(value, "case_ids", path);
      return cases.ok ? ok(taskItem("cohort_file", "/cohorts/*", path, id.value, value,
        cases.value.map((caseId, index) => studyTaskLink({
          type: "addresses", target_task_kind: "case", target_local_id: caseId, evidence_ref: `${path}/case_ids/${index}`,
        })), "cohort_file")) : cases;
    }))]),
  ];
}

export const registrations: readonly Registration[] = [
  ...studyRegistrations(),
  ...[
    study.design.observed_state, study.design.pr, study.design.pr_state, study.design.spend_request,
    study.expand.observed_state, study.expand.pr, study.expand.pr_state,
    study.freeze.observed_state, study.freeze.pr, study.freeze.pr_state,
    study.integration.manual_merge_target, study.integration.observed_state, study.integration.pr, study.integration.pr_state,
    study.repository_setup.workspace,
  ].map((key) => register(key, [])),
];
