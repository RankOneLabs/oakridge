/**
 * Run `work` only after everything already queued under `key`.
 *
 * Several session operations must not interleave per key — two ensures of the
 * same resumable session, an advance racing an ensure, two deliveries of one
 * input key — and each had grown its own copy of this chain.
 *
 * Two details are load-bearing and were easy to get subtly different between
 * copies. The stored tail swallows rejection, so one failed operation does not
 * poison every operation queued behind it. And the entry is deleted only while
 * it is still the tail, so a later caller that has already chained onto it is
 * never dropped — that check is what keeps the map from growing without bound
 * without also losing the ordering it exists to provide.
 *
 * Queueing is synchronous up to the return, so two calls in the same tick
 * serialize rather than both seeing an empty chain.
 */
export const serializeByKey = <Key, Value>(
  chains: Map<Key, Promise<unknown>>,
  key: Key,
  work: () => Promise<Value>,
): Promise<Value> => {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(work);
  const tail = result.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return result;
};
