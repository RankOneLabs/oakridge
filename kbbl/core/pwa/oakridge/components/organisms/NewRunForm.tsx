import { OperatorLaunchView } from "../../views/OperatorLaunchView";
interface Props { readonly onBack: () => void; readonly onCreated: (id: string) => void; readonly onEdit: () => void }
export function NewRunForm(props: Props) { return <OperatorLaunchView {...props} />; }
