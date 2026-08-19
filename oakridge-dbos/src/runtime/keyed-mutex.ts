/**
 * Per-key in-process serialization.
 *
 * Some git operations race when two run concurrently against the same working
 * copy: both try to lock the same ref, and the loser dies with "cannot lock
 * ref ... unable to update local ref". Two runs provisioning epic branches in
 * the same repository are exactly that case, and so is a step retried while its
 * predecessor is still in flight. Keying the lock by repository path lets
 * unrelated repositories proceed in parallel while same-repository operations
 * queue behind one another.
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `operation` so that no two invocations sharing `key` overlap. Invocations
 * with different keys are unaffected. The returned promise settles with the
 * operation's own value or error; a rejecting operation does not poison later
 * waiters on the same key.
 */
export const runExclusive = <Value>(key: string, operation: () => Promise<Value>): Promise<Value> => {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  // The stored tail never rejects, so a failing operation neither poisons the
  // next waiter nor escapes as an unhandled rejection.
  const tail = result.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    // Drop the key once its chain has drained, so the map does not grow
    // unbounded across many distinct repositories over the process lifetime.
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
};
