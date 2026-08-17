/**
 * Look up a key that came from outside — an HTTP path segment, an edge in an
 * uploaded workflow definition, a gate action name — without seeing anything
 * inherited from `Object.prototype`.
 *
 * A plain `record[key]` answers truthily for `constructor`, `toString` and
 * `__proto__` on any object literal, so a membership check written as
 * `if (!record[key])` silently passes for names that are not in the record at
 * all. What follows then reads a `Function` where it expected a domain value:
 * either it crashes on the first property access, or — worse — it proceeds,
 * because the guard that was supposed to stop it has already said yes.
 */
export const readOwn = <Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/** Whether a key is genuinely present, as opposed to inherited. */
export const hasOwn = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);
