/**
 * The database an end-to-end test runs against.
 *
 * These tests drive the real DBOS runtime rather than a stub of it, so they
 * need a real PostgreSQL. That is a heavier prerequisite than the rest of the
 * suite, which is pure in-memory — so a missing database skips them rather
 * than failing. CI provides one as a service container; locally, the dev
 * stack's container is already listening.
 *
 * The skip is deliberately loud at the call site: a silently-skipped e2e is
 * indistinguishable from a passing one, which is the failure mode this whole
 * layer exists to stop.
 */
const DEV_STACK_DATABASE_URL = "postgres://oakridge:oakridge@127.0.0.1:54329/oakridge";

/** The URL to test against, or null when no database is reachable. */
export const findTestDatabaseUrl = async (): Promise<string | null> => {
  const candidate = process.env.OAKRIDGE_TEST_DATABASE_URL ?? process.env.DBOS_SYSTEM_DATABASE_URL ?? DEV_STACK_DATABASE_URL;
  return (await isReachable(candidate)) ? candidate : null;
};

/**
 * Whether a server is actually accepting connections, rather than merely
 * configured. An unreachable URL from the environment should skip like an
 * absent one — the alternative is a suite that fails on every machine where
 * the dev stack happens to be stopped.
 */
const isReachable = async (url: string): Promise<boolean> => {
  const parsed = parsePostgresUrl(url);
  if (!parsed) return false;
  try {
    const socket = await Bun.connect({ hostname: parsed.hostname, port: parsed.port, socket: { data() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
};

interface PostgresEndpoint {
  readonly hostname: string;
  readonly port: number;
}

const parsePostgresUrl = (url: string): PostgresEndpoint | null => {
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname, port: Number(parsed.port || 5432) };
  } catch {
    return null;
  }
};
