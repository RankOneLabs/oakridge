import { TextInput } from "../../../components/atoms/TextInput";
import type { StudySliceDraft } from "../../lib/workflow-launch-input";
import { FormField } from "./FormField";

interface StudySliceFieldsProps {
  readonly draft: StudySliceDraft;
  readonly onChange: (draft: StudySliceDraft) => void;
  readonly disabled: boolean;
}

/** The limits a study's design stage must keep its pilot slice within. */
export function StudySliceFields({ draft, onChange, disabled }: StudySliceFieldsProps) {
  return <div className="flex flex-col gap-4" data-testid="or-new-run-study-slice">
    <FormField label="Slice case limit" hint="The most cases the pilot slice may run before the full study.">
      <TextInput aria-label="Slice case limit" inputMode="numeric" value={draft.case_limit} disabled={disabled} required
        onChange={(event) => onChange({ ...draft, case_limit: event.target.value })} />
    </FormField>
    <FormField label="Slice spending cap (USD)" hint="The most the pilot slice may spend on paid models.">
      <TextInput aria-label="Slice spending cap (USD)" inputMode="decimal" value={draft.cap_dollars} disabled={disabled} required
        onChange={(event) => onChange({ ...draft, cap_dollars: event.target.value })} />
    </FormField>
  </div>;
}
