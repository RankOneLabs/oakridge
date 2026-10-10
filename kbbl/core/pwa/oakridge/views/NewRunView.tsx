import { NewRunForm } from "../components/organisms/NewRunForm";
interface Props { readonly onBack: () => void; readonly onCreated: (id: string) => void; readonly onEdit: () => void }
export function NewRunView(props: Props) { return <NewRunForm {...props} />; }
