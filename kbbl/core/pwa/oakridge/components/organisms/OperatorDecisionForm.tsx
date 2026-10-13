import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { submitOperatorDecision } from "../../client";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import { clearOperatorDraft, clearPendingDecision, findRetainedDrafts, readOperatorDraft, readPendingDecision, saveOperatorDraft, savePendingDecision,
  type OperatorDecisionSubmission } from "../../lib/operator-drafts";
import { buildRootInput, isOptionalSchema, stringFloor, type FieldDrafts } from "../../lib/operator-input";
import { parseOperatorFieldValue } from "../../lib/operator-payload";
import { selectDraftKey } from "../../lib/operator-selectors";
import type { OperatorDecisionDefinition, OperatorSchema, OperatorUnitView } from "../../operator-contracts";

interface Props { readonly unit: OperatorUnitView; readonly decision: OperatorDecisionDefinition;
  readonly schemas: readonly OperatorSchema[]; readonly onRefresh: () => void }

export function OperatorDecisionForm({ unit, decision, schemas, onRefresh }: Props) {
  const key = selectDraftKey(unit, decision);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const [draft, setDraft] = useState(() => readOperatorDraft(key));
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAccepted, setIsAccepted] = useState(false);
  const shape = schemas.find((schema) => schema.key === decision.payload_schema)?.shape;
  const fields = shape?.kind === "record" ? shape.fields : null;

  async function deliver(input: OperatorDecisionSubmission): Promise<void> {
    setIsSubmitting(true);
    try {
      await submitOperatorDecision(input);
      clearPendingDecision(input);
      clearOperatorDraft(input);
      if (isMounted.current) {
        setDraft("");
        setIsAccepted(true);
        setError("");
        onRefresh();
      }
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        clearPendingDecision(input);
        if (isMounted.current) {
          onRefresh();
          setError(`${cause instanceof Error ? cause.message : "Decision rejected"}. Your input is kept.`);
        }
      } else if (isMounted.current) setError(`Delivery is uncertain. Request ${input.request_id} will be retried with the same payload.`);
    } finally { if (isMounted.current) setIsSubmitting(false); }
  }

  useEffect(() => {
    const pending = readPendingDecision(key);
    if (pending) void deliver(pending);
    // The component is keyed by its draft identity, so this runs once per decision and target revision;
    // a pending decision whose form is gone is recovered by the run view instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (value: string) => { setIsAccepted(false); setDraft(value); saveOperatorDraft(key, value); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsAccepted(false);
    try {
      let payload: unknown;
      if (fields) {
        const entered = JSON.parse(draft || "{}") as FieldDrafts;
        payload = buildRootInput("{}", fields.map((field) => ({ field, schema: schemas.find((schema) => schema.key === field.schema) })), entered);
      } else {
        const parsed = parseOperatorFieldValue({ raw: draft, schema: schemas.find((schema) => schema.key === decision.payload_schema) });
        if (!parsed.ok) { setError(parsed.error.detail); return; }
        payload = parsed.value;
      }
      const pending = readPendingDecision(key) ?? { ...key, submit: decision.submit, request_id: randomUuid(), payload };
      savePendingDecision(pending);
      void deliver(pending);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid payload"); }
  };
  const rawFields: { readonly [field: string]: string } = (() => { try { return JSON.parse(draft || "{}"); } catch { return {}; } })();
  const retained = findRetainedDrafts(key);
  return <form onSubmit={submit} className="flex flex-col gap-3" data-testid="operator-command-form">
    {retained.map((previous) => <details key={previous.identity}><summary>Draft from an earlier target revision</summary><pre>{previous.text}</pre></details>)}
    {fields ? fields.map((field) => {
      const fieldSchema = schemas.find((schema) => schema.key === field.schema);
      const label = decision.fields.find((item) => item.key === field.key)?.label ?? field.key;
      const isRequired = !isOptionalSchema(fieldSchema);
      const value = rawFields[field.key] ?? "";
      const change = (next: string) => update(JSON.stringify({ ...rawFields, [field.key]: next }));
      return <label key={field.key} className="flex flex-col gap-1">{label}
        {fieldSchema?.shape.kind === "enum" ? <select value={value} required={isRequired} onChange={(event) => change(event.target.value)}><option value="">Select…</option>{fieldSchema.shape.variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select>
          : fieldSchema?.shape.kind === "boolean" ? <select value={value} required={isRequired} onChange={(event) => change(event.target.value)}><option value="">Select…</option><option value="true">Yes</option><option value="false">No</option></select>
          : fieldSchema?.shape.kind === "integer" ? <input type="number" value={value} required={isRequired} min={fieldSchema.shape.min} max={fieldSchema.shape.max} onChange={(event) => change(event.target.value)} />
          : <textarea value={value} required={isRequired && stringFloor(fieldSchema) !== 0} minLength={fieldSchema?.shape.kind === "string" ? fieldSchema.shape.min_length : undefined}
            maxLength={fieldSchema?.shape.kind === "string" ? fieldSchema.shape.max_length : undefined} onChange={(event) => change(event.target.value)} />}</label>;
    }) : <label className="flex flex-col gap-1">Payload<textarea value={draft} onChange={(event) => update(event.target.value)} /></label>}
    <Button type="submit" variant="primary" disabled={isSubmitting}>{isSubmitting ? "Submitting…" : `Submit ${decision.label}`}</Button>
    {isAccepted && <p role="status">Decision accepted.</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
