import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone, type StatusToneSource } from "../../lib/status-tone";

interface StatusBadgeProps {
  status: StatusToneSource;
  testId?: string;
}

export function StatusBadge({ status, testId }: StatusBadgeProps) {
  return <Chip tone={selectStatusTone(status)} testId={testId}>{status}</Chip>;
}
