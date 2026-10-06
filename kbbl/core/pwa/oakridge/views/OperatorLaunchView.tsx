import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitions, launchOperatorRun } from "../client";
import { Button } from "../../components/atoms/Button";

import { randomUuid } from "../../lib/random-uuid";
import { clearPendingLaunch, readPendingLaunch, savePendingLaunch } from "../lib/operator-launch";
import { isDefinitiveRequestRejection } from "../lib/client-errors";
import type { OperatorLaunchRequest } from "../operator-contracts";

interface Props { readonly onBack: () => void; readonly onCreated: (runId: string) => void; readonly onEdit: () => void }
export function OperatorLaunchView({ onBack, onCreated, onEdit }: Props) {
  const definitions = useQuery({ queryKey: ["operator", "definitions"], queryFn: fetchOperatorDefinitions });
  const [pending, setPending] = useState<OperatorLaunchRequest | null>(() => {
    try { return readPendingLaunch(); } catch { return null; } // Submission re-reads and fails closed if storage is unavailable or corrupt.
  });
  const deliveryInProgress = useRef(false);
  const [digest, setDigest] = useState("");
  const [input, setInput] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const selected = pending?.digest || digest || definitions.data?.[0]?.digest || "";
  const launch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (deliveryInProgress.current) return;
    setError(null);
    let request: OperatorLaunchRequest;
    try {
      const retained = readPendingLaunch();
      request = retained ?? { request_id: randomUuid(), digest: selected, input: JSON.parse(input) };
      savePendingLaunch(request);
      setPending(request);
    } catch (cause) { setError(String(cause)); return; }
    deliveryInProgress.current = true;
    setLaunching(true);
    try {
      const run = await launchOperatorRun(request);
      clearPendingLaunch(request);
      setPending(null);
      onCreated(run.run_id);
    } catch (cause) {
      if (isDefinitiveRequestRejection(cause)) {
        try { clearPendingLaunch(request); setPending(null); }
        catch { /* Keep the retained identity if storage is unavailable. */ }
        setError(String(cause));
      } else setError("Launch delivery is uncertain. Retry to recover the original run.");
    } finally { deliveryInProgress.current = false; setLaunching(false); }
  };
  return <main className="or-page" data-testid="or-new-run">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Launch pinned run</h1></header>
    {definitions.isError && <p role="alert">{String(definitions.error)}</p>}
    {definitions.data?.length === 0 && <p>No pinned definition yet. <Button onClick={onEdit}>Edit definition</Button></p>}
    <form onSubmit={(event) => void launch(event)}>
      <label htmlFor="operator-digest">Definition digest</label>
      <select id="operator-digest" value={selected} disabled={pending !== null || launching} onChange={(event) => setDigest(event.target.value)}>
        {pending && !definitions.data?.some((item) => item.digest === pending.digest)
          && <option value={pending.digest}>{pending.digest}</option>}
        {definitions.data?.map((item) => <option key={item.digest} value={item.digest}>{item.source.key} v{item.source.version} · {item.digest}</option>)}
      </select>
      <label htmlFor="operator-input">Root input JSON</label>
      <textarea id="operator-input" value={pending ? JSON.stringify(pending.input, null, 2) : input} disabled={pending !== null || launching} onChange={(event) => setInput(event.target.value)} className="w-full min-h-48 rounded-md border p-3 font-mono text-xs" />
      {pending && <p role="status">A launch is awaiting confirmation. Retry to recover its result.</p>}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!selected || launching}>{pending ? "Retry launch" : "Launch"}</Button>
    </form>
  </main>;
}
