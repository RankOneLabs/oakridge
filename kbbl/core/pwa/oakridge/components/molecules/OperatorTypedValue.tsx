import type { OperatorBodyValue } from "../../operator-contracts";
import { isBodyList, isBodyRecord } from "../../artifact-types";

interface Props { readonly value: OperatorBodyValue }
/** Any JSON body: a record as labelled fields, a list as an ordered list, null as a dash. */
export function OperatorTypedValue({ value }: Props) {
  if (isBodyRecord(value)) return <dl data-testid="operator-typed-value">{Object.entries(value).map(([key, field]) =>
    <div key={key}><dt>{key}</dt><dd><OperatorTypedValue value={field} /></dd></div>)}</dl>;
  if (isBodyList(value)) return <ol data-testid="operator-typed-value">{value.map((item, index) => <li key={index}><OperatorTypedValue value={item} /></li>)}</ol>;
  if (value === null) return <span>—</span>;
  return <span data-testid="operator-typed-value">{String(value)}</span>;
}
