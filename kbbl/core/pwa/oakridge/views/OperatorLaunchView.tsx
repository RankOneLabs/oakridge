import { queryKeys } from "../queryKeys";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitions, launchOperatorRun } from "../client";
import { Button } from "../../components/atoms/Button";

import { randomUuid } from "../../lib/random-uuid";
import { clearPendingLaunch, readPendingLaunch, savePendingLaunch } from "../lib/operator-launch";
import { isDefinitiveRequestRejection } from "../lib/client-errors";
import type { OperatorLaunchRequest } from "../operator-contracts";
import type { Schema, SchemaField, WorkflowDefinitionDescriptor } from "../workflow-definition-types";
import { parseOperatorFieldValue } from "../lib/operator-payload";

interface RootField { readonly field: SchemaField; readonly schema: Schema | undefined }
type FieldDrafts = { readonly [key: string]: string };

function selectRootFields(source: WorkflowDefinitionDescriptor | undefined): readonly RootField[] | null {
  if (!source || !Array.isArray(source.scopes) || !Array.isArray(source.schemas)) return null;
  const root = source.scopes.find((scope) => scope.key === source.root);
  const shape = source.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  return shape?.kind === "record" ? shape.fields.map((field) => ({ field,
    schema: source.schemas.find((schema) => schema.key === field.schema) })) : null;
}

function inputRecord(raw: string): { [key: string]: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Root input must be a JSON object.");
  return parsed as { [key: string]: unknown };
}

function fieldText(value: unknown, schema: Schema | undefined): string {
  if (value === undefined) return "";
  return schema?.shape.kind === "string" || schema?.shape.kind === "enum" ? String(value) : JSON.stringify(value, null, 2);
}

function buildRootInput(raw: string, fields: readonly RootField[] | null, drafts: FieldDrafts): unknown {
  if (!fields) return JSON.parse(raw);
  const record = inputRecord(raw);
  for (const { field, schema } of fields) {
    const draft = drafts[field.key];
    if (draft === undefined) {
      if (field.required && record[field.key] === undefined) throw new Error(`${field.key} is required.`);
      continue;
    }
    if (draft.trim() === "") {
      if (field.required) throw new Error(`${field.key} is required.`);
      delete record[field.key];
      continue;
    }
    const parsed = parseOperatorFieldValue({ raw: draft, schema });
    if (!parsed.ok) throw new Error(`${field.key}: ${parsed.error.detail}`);
    record[field.key] = parsed.value;
  }
  return record;
}

interface Props { readonly onBack: () => void; readonly onCreated: (runId: string) => void; readonly onEdit: () => void }
export function OperatorLaunchView({ onBack, onCreated, onEdit }: Props) {
  const definitions = useQuery({ queryKey: queryKeys.definitions, queryFn: fetchOperatorDefinitions });
  const [pending, setPending] = useState<OperatorLaunchRequest | null>(() => {
    try { return readPendingLaunch(); } catch { return null; } // Submission re-reads and fails closed if storage is unavailable or corrupt.
  });
  const deliveryInProgress = useRef(false);
  const [digest, setDigest] = useState("");
  const [input, setInput] = useState("{}");
  const [fieldDrafts, setFieldDrafts] = useState<FieldDrafts>({});
  const [rawMode, setRawMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const selected = pending?.digest || digest || definitions.data?.[0]?.digest || "";
  const selectedDefinition = definitions.data?.find((item) => item.digest === selected);
  const fields = selectRootFields(selectedDefinition?.source);
  const inputValues = (() => { try { return inputRecord(input); } catch { return {}; } })();
  const toggleRaw = () => {
    setError(null);
    try {
      if (!rawMode) { setInput(JSON.stringify(buildRootInput(input, fields, fieldDrafts), null, 2)); setFieldDrafts({}); }
      else inputRecord(input);
      setRawMode(!rawMode);
    } catch (cause) { setError(String(cause)); }
  };
  const launch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (deliveryInProgress.current) return;
    setError(null);
    let request: OperatorLaunchRequest;
    try {
      const retained = readPendingLaunch();
      request = retained ?? { request_id: randomUuid(), digest: selected,
        input: rawMode ? JSON.parse(input) : buildRootInput(input, fields, fieldDrafts) };
      savePendingLaunch(request);
      setPending(request);
    } catch (cause) { setError(String(cause)); return; }
    deliveryInProgress.current = true;
    setLaunching(true);
    try {
      const run = await launchOperatorRun(request);
      clearPendingLaunch(request);
      setPending(null);
      onCreated(run.run_id);
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        try { clearPendingLaunch(request); setPending(null); }
        catch { /* Keep the retained identity if storage is unavailable. */ }
        setError(String(cause));
      } else setError("Launch delivery is uncertain. Retry to recover the original run.");
    } finally { deliveryInProgress.current = false; setLaunching(false); }
  };
  return <main className="or-page" data-testid="or-new-run">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Launch pinned run</h1></header>
    {definitions.isError && <p role="alert">{String(definitions.error)}</p>}
    {definitions.data?.length === 0 && <p>No pinned definition yet. <Button onClick={onEdit}>Edit definition</Button></p>}
    <form onSubmit={(event) => void launch(event)}>
      <label htmlFor="operator-digest">Definition digest</label>
      <select id="operator-digest" value={selected} disabled={pending !== null || launching} onChange={(event) => {
        setDigest(event.target.value); setInput("{}"); setFieldDrafts({}); setRawMode(false);
      }}>
        {pending && !definitions.data?.some((item) => item.digest === pending.digest)
          && <option value={pending.digest}>{pending.digest}</option>}
        {definitions.data?.map((item) => <option key={item.digest} value={item.digest}>{item.source.key} v{item.source.version} · {item.digest}</option>)}
      </select>
      {fields && <label className="flex items-center gap-2"><input type="checkbox" checked={rawMode} disabled={pending !== null || launching}
        onChange={toggleRaw} />Raw JSON</label>}
      {(rawMode || fields === null || pending !== null) ? <>
        <label htmlFor="operator-input">Root input JSON</label>
        <textarea id="operator-input" value={pending ? JSON.stringify(pending.input, null, 2) : input} disabled={pending !== null || launching}
          onChange={(event) => setInput(event.target.value)} className="w-full min-h-48 rounded-md border p-3 font-mono text-xs" />
      </> : <div className="flex flex-col gap-3">{fields.map(({ field, schema }) => {
        const value = fieldDrafts[field.key] ?? fieldText(inputValues[field.key], schema);
        const setValue = (next: string) => setFieldDrafts((current) => ({ ...current, [field.key]: next }));
        const label = `${field.key}${schema && !["string", "integer", "boolean", "enum"].includes(schema.shape.kind) ? " JSON" : ""}`;
        const id = `operator-root-${field.key}`;
        return <div key={field.key} className="flex flex-col gap-1"><label htmlFor={id}>{label}</label>
          {schema?.shape.kind === "enum" ? <select id={id} value={value} required={field.required} onChange={(event) => setValue(event.target.value)}>
            <option value="">Select…</option>{schema.shape.variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
          </select> : schema?.shape.kind === "boolean" ? <select id={id} value={value} required={field.required} onChange={(event) => setValue(event.target.value)}>
            <option value="">Select…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : schema?.shape.kind === "integer" ? <input id={id} type="number" value={value} required={field.required}
            min={schema.shape.min} max={schema.shape.max} onChange={(event) => setValue(event.target.value)} />
          : schema?.shape.kind === "string" ? <input id={id} type="text" value={value} required={field.required}
            minLength={schema.shape.min_length} maxLength={schema.shape.max_length} onChange={(event) => setValue(event.target.value)} />
          : <textarea id={id} value={value} required={field.required} onChange={(event) => setValue(event.target.value)}
            className="w-full min-h-24 rounded-md border p-3 font-mono text-xs" />}</div>;
      })}</div>}
      {pending && <p role="status">A launch is awaiting confirmation. Retry to recover its result.</p>}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!selected || launching}>{pending ? "Retry launch" : "Launch"}</Button>
    </form>
  </main>;
}
