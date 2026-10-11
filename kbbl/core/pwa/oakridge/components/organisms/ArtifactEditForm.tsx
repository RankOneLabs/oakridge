import { useState } from "react";
import type { OperatorArtifactRevisionRecord, OperatorCommandDefinition, OperatorOutputSlotView, OperatorSchema, OperatorScopeView } from "../../operator-contracts";
import { useAtomEdit } from "../../hooks/useAtomEdit";
import { replaceCheckedText, selectCheckedTextFields } from "../../lib/checked-text-edit";
import { Button } from "../../../components/atoms/Button";

interface Props {
  readonly scope: OperatorScopeView;
  readonly output: OperatorOutputSlotView;
  readonly revision: OperatorArtifactRevisionRecord;
  readonly command: OperatorCommandDefinition;
  readonly schemas: readonly OperatorSchema[];
  readonly onEdited: () => void;
}

export function ArtifactEditForm({ scope, output, revision, command, schemas, onEdited }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [values, setValues] = useState<Readonly<{ readonly [key: string]: string }>>({});
  const edit = useAtomEdit();
  const fields = selectCheckedTextFields(revision.body, schemas);
  if (fields.length === 0) return null;
  const changed = fields.some((field) => (values[JSON.stringify(field.path)] ?? field.value) !== field.value);
  return <section data-testid="or-artifact-edit"><h3>Edit artifact</h3>
    {!isEditing ? <Button variant="secondary" onClick={() => setIsEditing(true)}>Edit artifact</Button>
      : <form onSubmit={(event) => {
        event.preventDefault();
        let body = revision.body;
        for (const field of fields) {
          const next = values[JSON.stringify(field.path)] ?? field.value;
          if (next === field.value) continue;
          const replaced = replaceCheckedText(body, field.path, next);
          if (!replaced) return;
          body = replaced;
        }
        if (body === revision.body) return;
        edit.mutate({ scope, command, output_key: output.output_key, collection_key: output.collection_key,
          reviewed_revision_id: revision.id, prev_value: revision.body, body },
        { onSuccess: () => { setIsEditing(false); onEdited(); }, onError: onEdited });
      }}>
        {fields.map((field) => <label key={JSON.stringify(field.path)} className="flex flex-col gap-1">
          {field.label}<textarea aria-label={field.label} value={values[JSON.stringify(field.path)] ?? field.value}
            onChange={(event) => setValues((prior) => ({ ...prior, [JSON.stringify(field.path)]: event.target.value }))} />
        </label>)}
        <Button type="submit" disabled={!changed || edit.isPending}>Save edit</Button>
        <Button variant="secondary" onClick={() => { setIsEditing(false); setValues({}); }}>Cancel edit</Button>
      </form>}
    {edit.isError && <p role="alert">Could not edit artifact: {String(edit.error)}</p>}
  </section>;
}
