import { CreateProjectForm } from "../components/organisms/CreateProjectForm";

interface CreateProjectViewProps {
  onBack: () => void;
  onCreated: () => void;
}

export function CreateProjectView(props: CreateProjectViewProps) {
  return <CreateProjectForm {...props} />;
}
