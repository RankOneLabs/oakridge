import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone, type StatusSubject } from "../../lib/status-tone";

interface Props { readonly subject: StatusSubject; readonly label?: string; readonly testId?: string }
export function StatusBadge({ subject, label, testId }: Props) {
  return <Chip tone={selectStatusTone(subject)} testId={testId}>{label ?? subject.status}</Chip>;
}
