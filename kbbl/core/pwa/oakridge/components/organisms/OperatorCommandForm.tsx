import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { submitOperatorCommand } from "../../client";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import { clearOperatorDraft, clearPendingCommand, findRetainedDrafts, operatorDraftIdentity, readOperatorDraft, readPendingCommand, saveOperatorDraft, savePendingCommand } from "../../lib/operator-drafts";
import { buildRootInput, type FieldDrafts, type InputField } from "../../lib/operator-input";
import { parseOperatorFieldValue } from "../../lib/operator-payload";
import { parseTypeExpression } from "../../lib/type-expression";
import { selectDraftKey } from "../../lib/operator-selectors";
import type { OperatorAvailableDecision, OperatorUnitView } from "../../operator-contracts";

interface Props { readonly unit: OperatorUnitView; readonly decision: OperatorAvailableDecision; readonly onRefresh: () => void }

/** v1 shipped a consequence sentence; v2 states the decision's effect instead. */
const consequenceOf = (decision: OperatorAvailableDecision): string =>
  decision.effect === "approve" ? "This decision approves the reviewed revision." : "This decision requests changes to the reviewed revision.";

export function OperatorCommandForm({ unit, decision, onRefresh }: Props) {
  const key = selectDraftKey(unit, decision);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const [draft, setDraft] = useState(() => key ? readOperatorDraft(key) : "");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAccepted, setIsAccepted] = useState(false);
  // A decision collects its declared fields; with none, it submits one payload value.
  const fields: readonly InputField[] | null = Object.keys(decision.fields).length > 0
    ? Object.entries(decision.fields).map(([field, type]) => ({ key: field, type, is_optional: parseTypeExpression(type).is_optional }))
    : null;
  const inputs = Object.entries(decision.inputs);

  async function deliver(input: NonNullable<ReturnType<typeof readPendingCommand>>): Promise<void> {
    setIsSubmitting(true);
    try {
      await submitOperatorCommand(input);
      clearPendingCommand(input);
      clearOperatorDraft(input);
      if (isMounted.current) {
        setDraft("");
        setIsAccepted(true);
        setError("");
        onRefresh();
      }
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        clearPendingCommand(input);
        if (isMounted.current) {
          onRefresh();
          setError(`${cause instanceof Error ? cause.message : "Decision rejected"}. Your input is kept.`);
        }
      } else if (isMounted.current) setError(`Delivery is uncertain. Request ${input.request_id} will be retried with the same payload.`);
    } finally { if (isMounted.current) setIsSubmitting(false); }
  }

  useEffect(() => {
    if (!key) return;
    const pending = readPendingCommand(key);
    if (pending) void deliver(pending);
    // The component is keyed by its form identity, so this runs once per decision and target revision;
    // a pending decision left under an earlier owner version is recovered by the run view instead.
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

  if (!key) return <p role="status">The target revision is unavailable. Refresh this unit before acting.</p>;

  const update = (value: string) => { setIsAccepted(false); setDraft(value); saveOperatorDraft(key, value); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsAccepted(false);
    try {
      let payload: unknown;
      if (fields) {
        const entered = JSON.parse(draft || "{}") as FieldDrafts;
        payload = buildRootInput("{}", fields, entered);
      } else {
        const parsed = parseOperatorFieldValue({ raw: draft, type: decision.payload ?? "text" });
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
    <p>{consequenceOf(decision)}</p>
    {retained.map((previous) => <details key={previous.identity}><summary>Draft from an earlier owner version or target revision</summary><pre>{previous.text}</pre></details>)}
    {inputs.map(([name, expression]) => <details key={name} data-testid="operator-prefilled-field">
      <summary>{name}: from the review&apos;s evidence</summary>
      <pre>{expression}</pre></details>)}
    {fields ? fields.map((field) => {
      const parsed = parseTypeExpression(field.type);
      const value = rawFields[field.key] ?? "";
      const required = !field.is_optional;
      const change = (next: string) => update(JSON.stringify({ ...rawFields, [field.key]: next }));
      return <label key={field.key} className="flex flex-col gap-1">{field.key}
        {parsed.kind === "leaf" && parsed.leaf === "boolean"
          ? <select value={value} required={required} onChange={(event) => change(event.target.value)}><option value="">Select…</option><option value="true">Yes</option><option value="false">No</option></select>
          : parsed.kind === "leaf" && parsed.leaf === "integer"
            ? <input type="number" value={value} required={required} onChange={(event) => change(event.target.value)} />
            : <textarea value={value} required={required} onChange={(event) => change(event.target.value)} />}</label>;
    }) : <label className="flex flex-col gap-1">Payload<textarea value={draft} onChange={(event) => update(event.target.value)} /></label>}
    <Button type="submit" variant="primary" disabled={isSubmitting}>{isSubmitting ? "Submitting…" : `Submit ${decision.label}`}</Button>
    {isAccepted && <p role="status">Decision accepted.</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
