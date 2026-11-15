import { useInstallStatus } from "../hooks/useInstallStatus";
import { InstallStatusContent } from "../components/molecules/InstallStatusContent";
export function StatusView() {
  const query = useInstallStatus();
  if (query.isError) return <p role="alert">Installation status unavailable: {query.error.message}</p>;
  return query.data ? <InstallStatusContent status={query.data} /> : <p>Loading installation status…</p>;
}
