import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { submitOperatorCommand } from "../../client";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import { clearOperatorDraft, clearPendingCommand, findRetainedDrafts, operatorDraftIdentity, readOperatorDraft, readPendingCommand, saveOperatorDraft, savePendingCommand } from "../../lib/operator-drafts";
import { buildRootInput, stringFloor, type FieldDrafts } from "../../lib/operator-input";
import { parseOperatorFieldValue } from "../../lib/operator-payload";
import { selectCommandPrefill, selectDraftKey, selectPendingEvidence } from "../../lib/operator-selectors";
import type { OperatorCommandDefinition, OperatorSchema, OperatorScopeView } from "../../operator-contracts";

interface Props { readonly scope: OperatorScopeView; readonly command: OperatorCommandDefinition;
  readonly schemas: readonly OperatorSchema[]; readonly onRefresh: () => void }

export function OperatorCommandForm({ scope, command, schemas, onRefresh }: Props) {
  const key = selectDraftKey(scope, command);
  const [draft, setDraft] = useState(() => key ? readOperatorDraft(key) : "");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAccepted, setIsAccepted] = useState(false);
  const shape = schemas.find((schema) => schema.key === command.payload_schema)?.shape;
  const prefill = selectCommandPrefill(scope, command);
  const record_fields = shape?.kind === "record" ? shape.fields : null;
  const fields = record_fields?.filter((field) => !(field.key in prefill)) ?? null;
  const prefilled = record_fields?.filter((field) => field.key in prefill) ?? [];

  async function deliver(input: NonNullable<ReturnType<typeof readPendingCommand>>): Promise<void> {
    setIsSubmitting(true);
    try {
      await submitOperatorCommand(input);
      clearPendingCommand(input);
      clearOperatorDraft(input);
      setDraft("");
      setIsAccepted(true);
      setError("");
      onRefresh();
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        clearPendingCommand(input);
        onRefresh();
        setError(`${cause instanceof Error ? cause.message : "Command rejected"}. Your input is kept.`);
      } else setError(`Delivery is uncertain. Request ${input.request_id} will be retried with the same payload.`);
    } finally { setIsSubmitting(false); }
  }

  useEffect(() => {
    if (!key) return;
    const pending = readPendingCommand(key);
    if (pending) void deliver(pending);
    // The component is keyed by its form identity, so this runs once per command and target revisions;
    // a pending command left under an earlier owner version is recovered by the run view instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The parent keys this form without the owner version, so a bump arrives as a new `key` on live
  // state: move the stored draft to the new version's identity rather than losing the edits.
  const storedKey = useRef(key);
  useEffect(() => {
    const previous = storedKey.current;
    storedKey.current = key ?? previous;
    if (!key || !previous || operatorDraftIdentity(previous) === operatorDraftIdentity(key)) return;
    if (draft !== "") saveOperatorDraft(key, draft);
    clearOperatorDraft(previous);
    // Only a change of the observed identity moves the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key ? operatorDraftIdentity(key) : null]);

  if (!key) return <p role="status">Target revisions are unavailable. Refresh this scope before acting.</p>;
  const pending_evidence = selectPendingEvidence(scope, command);
  if (pending_evidence.length > 0) return <p role="status" data-testid="operator-pending-evidence">Waiting for current evidence: {pending_evidence.join(", ")}.</p>;

  const update = (value: string) => { setIsAccepted(false); setDraft(value); saveOperatorDraft(key, value); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsAccepted(false);
    try {
      let payload: unknown;
      if (fields) {
        const entered = JSON.parse(draft || "{}") as FieldDrafts;
        payload = buildRootInput(JSON.stringify(prefill), fields.map((field) => ({ field, schema: schemas.find((schema) => schema.key === field.schema) })), entered);
      } else {
        const parsed = parseOperatorFieldValue({ raw: draft, schema: schemas.find((schema) => schema.key === command.payload_schema) });
        if (!parsed.ok) { setError(parsed.error.detail); return; }
        payload = parsed.value;
      }
      const pending = readPendingCommand(key) ?? { ...key, request_id: randomUuid(), payload };
      savePendingCommand(pending);
      void deliver(pending);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid payload"); }
  };
  const rawFields: { readonly [field: string]: string } = (() => { try { return JSON.parse(draft || "{}"); } catch { return {}; } })();
  const retained = findRetainedDrafts(key);
  return <form onSubmit={submit} className="flex flex-col gap-3" data-testid="operator-command-form">
    <p>{command.consequence}</p>
    {retained.map((previous) => <details key={previous.identity}><summary>Draft from an earlier owner version or target revision</summary><pre>{previous.text}</pre></details>)}
    {prefilled.map((field) => <details key={field.key} data-testid="operator-prefilled-field">
      <summary>{command.field_presentation.find((item) => item.key === field.key)?.presentation.label ?? field.key}: from current evidence</summary>
      <pre>{JSON.stringify(prefill[field.key], null, 2)}</pre></details>)}
    {fields ? fields.map((field) => {
      const fieldSchema = schemas.find((schema) => schema.key === field.schema);
      const presentation = command.field_presentation.find((item) => item.key === field.key)?.presentation;
      const value = rawFields[field.key] ?? "";
      const change = (next: string) => update(JSON.stringify({ ...rawFields, [field.key]: next }));
      return <label key={field.key} className="flex flex-col gap-1">{presentation?.label ?? field.key}
        {fieldSchema?.shape.kind === "enum" ? <select value={value} required={field.required} onChange={(event) => change(event.target.value)}><option value="">Select…</option>{fieldSchema.shape.variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select>
          : fieldSchema?.shape.kind === "boolean" ? <select value={value} required={field.required} onChange={(event) => change(event.target.value)}><option value="">Select…</option><option value="true">Yes</option><option value="false">No</option></select>
          : fieldSchema?.shape.kind === "integer" ? <input type="number" value={value} required={field.required} min={fieldSchema.shape.min} max={fieldSchema.shape.max} onChange={(event) => change(event.target.value)} />
          : <textarea value={value} required={field.required && stringFloor(fieldSchema) !== 0} minLength={fieldSchema?.shape.kind === "string" ? fieldSchema.shape.min_length : undefined}
            maxLength={fieldSchema?.shape.kind === "string" ? fieldSchema.shape.max_length : undefined} onChange={(event) => change(event.target.value)} />}</label>;
    }) : <label className="flex flex-col gap-1">Payload<textarea value={draft} onChange={(event) => update(event.target.value)} /></label>}
    <Button type="submit" variant="primary" disabled={isSubmitting}>{isSubmitting ? "Submitting…" : `Submit ${command.label}`}</Button>
    {isAccepted && <p role="status">Command accepted.</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
