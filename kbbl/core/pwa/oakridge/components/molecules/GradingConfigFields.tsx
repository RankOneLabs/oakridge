import type { ObservationJsonValue as Json } from "../../grading-contracts/domain/primitives";
import type { GradingPath } from "../../lib/grading-config";
import { jsonText } from "../../lib/grading-config";

export type GradingEdit = (path: GradingPath, value: Json) => void;
export interface GradingFieldProps { readonly label: string; readonly value: Json | undefined; readonly onChange: (value: Json) => void }
const control = "w-full rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2 text-[var(--text-primary)]";
export function GradingTextField({ label, value, onChange }: GradingFieldProps) {
  return <label className="grid gap-1">{label}<textarea aria-label={label} className={control} rows={2} value={jsonText(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}
interface GradingSelectProps extends GradingFieldProps { readonly options: readonly string[] }
export function GradingSelect({ label, value, options, onChange }: GradingSelectProps) {
  const selected = jsonText(value);
  return <label className="grid gap-1">{label}<select aria-label={label} className={control} value={selected} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose…</option>{selected && !options.includes(selected) && <option value={selected}>{selected} (unregistered)</option>}
    {options.map((option) => <option key={option} value={option}>{option}</option>)}
  </select></label>;
}
interface GradingJsonFieldProps { readonly label: string; readonly text: string; readonly error?: string; readonly onChange: (text: string) => void }
export function GradingJsonField({ label, text, error, onChange }: GradingJsonFieldProps) {
  return <label className="grid gap-1">{label}<textarea aria-label={label} className={`${control} font-mono`} rows={5} value={text} aria-invalid={!!error} onChange={(event) => onChange(event.target.value)} />{error && <span role="alert">JSON: {error}</span>}</label>;
}
