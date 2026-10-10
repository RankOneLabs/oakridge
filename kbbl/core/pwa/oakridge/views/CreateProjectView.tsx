import { CreateProjectForm } from "../components/organisms/CreateProjectForm";
import { Button } from "../../components/atoms/Button";
interface Props { readonly onBack: () => void }
export function CreateProjectView({ onBack }: Props) { return <main className="or-page" data-testid="or-create-project">
  <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Create project</h1></header>
  <CreateProjectForm onCreated={onBack} />
</main>; }
