import { NewRunForm } from "../components/organisms/NewRunForm";

interface NewRunViewProps {
  onBack: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunView(props: NewRunViewProps) {
  return <NewRunForm {...props} />;
}
