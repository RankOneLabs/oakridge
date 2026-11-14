import { useQuery } from "@tanstack/react-query";
import { fetchInstallStatus } from "../client";
export function useInstallStatus() {
  return useQuery({ queryKey: ["oakridge", "install-status"], queryFn: fetchInstallStatus, refetchInterval: 10_000 });
}
