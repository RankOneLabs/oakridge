/**
 * Per-key in-process serialization. kbbl runs many parallel dispatches in a
 * single Bun process; some shared-repo git operations (e.g. `git fetch origin
 * <epicBranch>`) race when two run concurrently in the same workdir, since both
 * try to lock the same ref and the loser fails with "cannot lock ref ... unable
 * to update local ref". Keying the lock by workdir lets unrelated repos proceed
 * in parallel while same-repo operations queue behind one another.
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` so that no two invocations sharing `key` overlap. Invocations with
 * different keys are unaffected. The returned promise settles with `fn`'s own
 * value or error; a thrown `fn` does not poison later waiters on the same key.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(() => fn());
  // The stored tail never rejects, so a failing `fn` neither poisons the next
  // waiter nor escapes as an unhandled rejection.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    // Drop the key once its chain has fully drained, so the map doesn't grow
    // unbounded across many distinct workdirs over the process lifetime.
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}
