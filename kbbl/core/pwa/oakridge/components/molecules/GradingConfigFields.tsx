import { TextArea } from "../../../components/atoms/TextArea";
import { Select } from "../../../components/atoms/Select";
import type { ObservationJsonValue as Json } from "../../grading-contracts/domain/primitives";
import type { GradingPath } from "../../lib/grading-config";
import { jsonText } from "../../lib/grading-config";

export type GradingEdit = (path: GradingPath, value: Json) => void;
export interface GradingFieldProps { readonly label: string; readonly value: Json | undefined; readonly onChange: (value: Json) => void }
export function GradingTextField({ label, value, onChange }: GradingFieldProps) {
  return <label className="grid gap-1">{label}<TextArea aria-label={label} rows={2} value={jsonText(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}
interface GradingSelectProps extends GradingFieldProps { readonly options: readonly string[] }
export function GradingSelect({ label, value, options, onChange }: GradingSelectProps) {
  const selected = jsonText(value);
  return <label className="grid gap-1">{label}<Select aria-label={label} value={selected} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose…</option>{selected && !options.includes(selected) && <option value={selected}>{selected} (unregistered)</option>}
    {options.map((option) => <option key={option} value={option}>{option}</option>)}
  </Select></label>;
}
interface GradingJsonFieldProps { readonly label: string; readonly text: string; readonly error?: string; readonly onChange: (text: string) => void }
export function GradingJsonField({ label, text, error, onChange }: GradingJsonFieldProps) {
  return <label className="grid gap-1">{label}<TextArea aria-label={label} className="font-mono" rows={5} value={text} aria-invalid={!!error} onChange={(event) => onChange(event.target.value)} />{error && <span role="alert">JSON: {error}</span>}</label>;
}
