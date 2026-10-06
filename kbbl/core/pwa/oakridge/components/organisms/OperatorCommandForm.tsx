import { useEffect, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { submitOperatorCommand } from "../../client";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import { clearOperatorDraft, clearPendingCommand, findRetainedDrafts, readOperatorDraft, readPendingCommand, saveOperatorDraft, savePendingCommand } from "../../lib/operator-drafts";
import { parseOperatorFieldValue } from "../../lib/operator-payload";
import { selectDraftKey } from "../../lib/operator-selectors";
import type { OperatorCommandDescriptor, OperatorSchema, OperatorScopeView } from "../../operator-contracts";

interface Props { readonly scope: OperatorScopeView; readonly command: OperatorCommandDescriptor;
  readonly schemas: readonly OperatorSchema[]; readonly onRefresh: () => void }

export function OperatorCommandForm({ scope, command, schemas, onRefresh }: Props) {
  const key = selectDraftKey(scope, command);
  const [draft, setDraft] = useState(() => key ? readOperatorDraft(key) : "");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const shape = schemas.find((schema) => schema.key === command.payload_schema)?.shape;
  const fields = shape?.kind === "record" ? shape.fields : null;

  async function deliver(input: NonNullable<ReturnType<typeof readPendingCommand>>): Promise<void> {
    setIsSubmitting(true);
    try {
      await submitOperatorCommand(input);
      clearPendingCommand(input);
      clearOperatorDraft(input);
      setCompleted(true);
      setError("");
      onRefresh();
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        clearPendingCommand(input);
        onRefresh();
        setError(`${cause instanceof Error ? cause.message : "Command rejected"}. Draft retained for this version.`);
      } else setError(`Delivery is uncertain. Request ${input.request_id} will be retried with the same payload.`);
    } finally { setIsSubmitting(false); }
  }

  useEffect(() => {
    if (!key) return;
    const pending = readPendingCommand(key);
    if (pending) void deliver(pending);
    // The component is keyed by its full draft identity, so this runs once per observed command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!key) return <p role="status">Target revisions are unavailable. Refresh this scope before acting.</p>;
  if (completed) return <p role="status">Command accepted.</p>;

  const update = (value: string) => { setDraft(value); saveOperatorDraft(key, value); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    try {
      let payload: unknown;
      if (fields) {
        const raw = JSON.parse(draft || "{}") as { readonly [field: string]: string };
        const entries: Array<readonly [string, unknown]> = [];
        for (const field of fields) {
          const value = raw[field.key];
          if (value === undefined || value === "") continue;
          const parsed = parseOperatorFieldValue({ raw: value, schema: schemas.find((schema) => schema.key === field.schema) });
          if (!parsed.ok) { setError(`${field.key}: ${parsed.error.detail}`); return; }
          entries.push([field.key, parsed.value]);
        }
        payload = Object.fromEntries(entries);
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
    {fields ? fields.map((field) => {
      const fieldSchema = schemas.find((schema) => schema.key === field.schema);
      const presentation = command.field_presentation.find((item) => item.key === field.key)?.presentation;
      const value = rawFields[field.key] ?? "";
      const change = (next: string) => update(JSON.stringify({ ...rawFields, [field.key]: next }));
      return <label key={field.key} className="flex flex-col gap-1">{presentation?.label ?? field.key}
        {fieldSchema?.shape.kind === "enum" ? <select value={value} required={field.required} onChange={(event) => change(event.target.value)}><option value="">Select…</option>{fieldSchema.shape.variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select>
          : fieldSchema?.shape.kind === "boolean" ? <select value={value} required={field.required} onChange={(event) => change(event.target.value)}><option value="">Select…</option><option value="true">Yes</option><option value="false">No</option></select>
          : fieldSchema?.shape.kind === "integer" ? <input type="number" value={value} required={field.required} min={fieldSchema.shape.min} max={fieldSchema.shape.max} onChange={(event) => change(event.target.value)} />
          : <textarea value={value} required={field.required} onChange={(event) => change(event.target.value)} />}</label>;
    }) : <label className="flex flex-col gap-1">Payload<textarea value={draft} onChange={(event) => update(event.target.value)} /></label>}
    <Button type="submit" variant="primary" disabled={isSubmitting}>{isSubmitting ? "Submitting…" : `Submit ${command.label}`}</Button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
