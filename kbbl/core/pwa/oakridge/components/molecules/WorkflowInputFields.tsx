import { TextArea } from "../../../components/atoms/TextArea";
import { Select } from "../../../components/atoms/Select";
import { TextInput } from "../../../components/atoms/TextInput";
import type { LaunchField, LaunchInputDraft } from "../../lib/workflow-launch-input";
import { FormField } from "./FormField";

interface WorkflowInputFieldsProps {
  readonly fields: readonly LaunchField[];
  readonly draft: LaunchInputDraft;
  readonly onChange: (key: string, value: string) => void;
  readonly disabled: boolean;
}

export function WorkflowInputFields({ fields, draft, onChange, disabled }: WorkflowInputFieldsProps) {
  return fields.map(({ key, optional, shape }) => {
    const value = draft[key] ?? "";
    const label = key.replaceAll("_", " ");
    const props = { "aria-label": label, value, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(key, event.target.value) };
    const variants = shape.kind === "enum" ? shape.variants : shape.kind === "boolean" ? ["true", "false"] : null;
    const control = variants ? <Select {...props}>
      <option value="">{optional ? "Unset" : "Select…"}</option>
      {variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
    </Select> : shape.kind === "list" || shape.kind === "record"
      ? <TextArea {...props} rows={5} />
      : shape.kind === "integer" ? <TextInput {...props} type="number" /> : <TextInput {...props} />;
    return <FormField key={key} label={label}>{control}</FormField>;
  });
}
