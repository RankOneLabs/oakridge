interface Props { readonly value: unknown }

/**
 * v2 bodies are plain JSON, so the value carries its own keys and needs no
 * pinned schema to label them.
 */
export function OperatorTypedValue({ value }: Props) {
  if (value === null || value === undefined) return <span data-testid="operator-typed-value">—</span>;
  if (Array.isArray(value)) return <ol data-testid="operator-typed-value">
    {value.map((item, index) => <li key={index}><OperatorTypedValue value={item} /></li>)}
  </ol>;
  if (typeof value === "object") return <dl data-testid="operator-typed-value">
    {Object.entries(value as { readonly [key: string]: unknown }).map(([key, nested]) => (
      <div key={key}><dt>{key}</dt><dd><OperatorTypedValue value={nested} /></dd></div>
    ))}
  </dl>;
  return <span data-testid="operator-typed-value">{String(value)}</span>;
}
