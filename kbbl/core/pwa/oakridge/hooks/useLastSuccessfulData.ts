import { useEffect, useState } from "react";

interface SuccessfulData<Value> { readonly scope: string; readonly value: Value }

/** A failed page read keeps the last successful page for this entity, including after placeholder data disappears. */
export function useLastSuccessfulData<Value>(value: Value | undefined, scope: string): Value | undefined {
  const [last, setLast] = useState<SuccessfulData<Value> | null>(null);
  useEffect(() => {
    if (value !== undefined) setLast({ scope, value });
  }, [value, scope]);
  return value ?? (last?.scope === scope ? last.value : undefined);
}
