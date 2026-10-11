import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";

interface Props { readonly status: string; readonly label?: string; readonly testId?: string }
export function StatusBadge({ status, label, testId }: Props) {
  return <Chip tone={selectStatusTone(status)} testId={testId}>{label ?? status}</Chip>;
}
