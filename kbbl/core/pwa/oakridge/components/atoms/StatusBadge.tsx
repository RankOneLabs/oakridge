import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";

interface Props { readonly status: string; readonly testId?: string }
export function StatusBadge({ status, testId }: Props) {
  return <Chip tone={selectStatusTone(status)} testId={testId}>{status}</Chip>;
}
