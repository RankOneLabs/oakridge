import type { OperatorCheckedValue, OperatorSchema } from "../../operator-contracts";

interface Props { readonly value: OperatorCheckedValue; readonly schemas: readonly OperatorSchema[] }
export function OperatorTypedValue({ value, schemas }: Props) {
  const shape = schemas.find((schema) => schema.key === value.schema)?.shape;
  const data = value.data;
  if (data.kind === "record") return <dl data-testid="operator-typed-value">{data.fields.map((field) => {
    const label = shape?.kind === "record" ? shape.fields[field.field_id]?.key : undefined;
    return <div key={field.field_id}><dt>{label ?? `Field ${field.field_id}`}</dt><dd>{field.value ? <OperatorTypedValue value={field.value} schemas={schemas} /> : "—"}</dd></div>;
  })}{data.dictionary.map((entry) => <div key={entry.key}><dt>{entry.key}</dt><dd><OperatorTypedValue value={entry.value} schemas={schemas} /></dd></div>)}</dl>;
  if (data.kind === "list") return <ol data-testid="operator-typed-value">{data.items.map((item, index) => <li key={index}><OperatorTypedValue value={item} schemas={schemas} /></li>)}</ol>;
  if (data.kind === "optional") return data.value ? <OperatorTypedValue value={data.value} schemas={schemas} /> : <span>—</span>;
  if (data.kind === "variant") return <div data-testid="operator-typed-value"><strong>{data.variant}</strong><OperatorTypedValue value={data.value} schemas={schemas} /></div>;
  if (data.kind === "enum") return <span data-testid="operator-typed-value">{data.variant}</span>;
  if (data.kind === "reference") return <span data-testid="operator-typed-value">{data.brand}: {data.id}</span>;
  return <span data-testid="operator-typed-value">{String(data.value)}</span>;
}
