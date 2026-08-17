/**
 * DBOS serialises event and stream payloads through superjson, which wraps some
 * values as `{"json": ...}` and stores others bare, so every read has to accept
 * both shapes. #426 was a bug from a single site getting that wrong, and the
 * expression had been retyped at sixteen call sites across two repositories.
 * It lives here once instead.
 */
export const superjsonValue = (column: string): string => `COALESCE((${column}::jsonb)->'json', ${column}::jsonb)`;

/** The same unwrap as a lateral join, for queries that read the payload more than once. */
export const superjsonValueLateral = (column: string, alias: string): string =>
  `CROSS JOIN LATERAL (SELECT ${superjsonValue(column)} AS value) ${alias}`;
