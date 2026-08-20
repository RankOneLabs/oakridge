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
 *
 * **Never the dev stack's own database.** These tests build the real backend
 * and launch runs through the real route, so every one writes real
 * `workflow_run`, `stage_instance` and `artifact` rows. Pointed at the
 * database the operator's UI reads, a day's test runs bury the operator's
 * actual work — which is exactly what happened once. The server is shared; the
 * database is not.
 */
import type { Result } from "../../src/domain/primitives";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";

/**
 * A connection to the dev stack's own database, used for two things and
 * nothing else: checking that the server is up, and creating the test database
 * beside it. Never to read or write a run.
 *
 * Named for what it connects to rather than what it is used to reach. This is
 * the one URL in the suite that points at the database a person reads, and a
 * reader who takes it for "just the server" is a `PgPostgresExecutor.connect`
 * away from the accident this whole file exists to prevent.
 */
const DEV_STACK_ADMIN_URL = "postgres://oakridge:oakridge@127.0.0.1:54329/oakridge";
/** Where a run's rows are allowed to land. Distinct from any database a person reads. */
const TEST_DATABASE_NAME = "oakridge_e2e";

/**
 * The URL to test against, or null when no database is reachable.
 *
 * An explicit `OAKRIDGE_TEST_DATABASE_URL` is taken at its word — CI points it
 * at a container that exists only for the run. Otherwise the dev stack's
 * *server* is used but not its database: a dedicated one is created beside it
 * on first use, so local runs are isolated without anyone configuring anything.
 */
export const findTestDatabaseUrl = async (): Promise<string | null> => {
  const configured = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (configured) return (await isReachable(configured)) ? configured : null;
  if (!(await isReachable(DEV_STACK_ADMIN_URL))) return null;
  return ensureTestDatabase(DEV_STACK_ADMIN_URL);
};

/**
 * Creates the dedicated test database if it is not there yet.
 *
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT
 * EXISTS`, so existence is checked first and a concurrent creator's duplicate
 * error is treated as success rather than raced over.
 */
const ensureTestDatabase = async (adminUrl: string): Promise<string | null> => {
  const url = new URL(adminUrl);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  const testUrl = url.toString();
  const admin = PgPostgresExecutor.connect(adminUrl);
  try {
    const existing = await admin.query<{ readonly name: string }>(
      "SELECT datname AS name FROM pg_database WHERE datname = $1", [TEST_DATABASE_NAME]);
    if (existing.length === 0) await admin.query(`CREATE DATABASE ${TEST_DATABASE_NAME}`, []);
    return testUrl;
  } catch (error) {
    // 42P04 is "database already exists" — another test process won the race,
    // which is the outcome we wanted anyway.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "42P04") return testUrl;
    console.warn(`dev-flow e2e SKIPPED: could not prepare '${TEST_DATABASE_NAME}': ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    await admin.close();
  }
};

/** An unquoted PostgreSQL identifier, which is all a scratch database needs. */
const SAFE_DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A database name, safe to interpolate.
 *
 * Validated *and* quoted. Validation is the real guard — a name outside this
 * shape is a caller bug, not something to escape around — but the quoting is
 * what a SAST rule reading the template literal can see, and a suppressed
 * warning nobody can verify is worse than two lines.
 */
const quotedDatabaseName = (name: string): Result<string, ScratchDatabaseError> =>
  SAFE_DATABASE_NAME.test(name)
    ? { ok: true, value: `"${name}"` }
    : { ok: false, error: { operation: "validate_scratch_database_name", database_name: name,
        detail: `a scratch database name must match ${String(SAFE_DATABASE_NAME)}` } };

/** A throwaway database, and the way to get rid of it. */
export interface ScratchDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/** Why a scratch database could not be prepared, and at which step. */
export interface ScratchDatabaseError {
  readonly operation: "validate_scratch_database_name" | "reach_admin_endpoint" | "create_scratch_database";
  readonly database_name: string;
  readonly detail: string;
}

/**
 * A database of its own, for a test that needs to control what schema it starts
 * from.
 *
 * The shared `oakridge_e2e` database records which migrations it has applied,
 * so a test that wants to run one *against data written before it* cannot use
 * it — the migration is already applied there. This gives such a test an empty
 * database it owns and destroys.
 *
 * A `Result` rather than a nullable: "no PostgreSQL here" is a skip and
 * "CREATE DATABASE was refused" is a failure, and a caller that cannot tell
 * them apart reports a broken environment as a clean skip.
 */
export const createScratchDatabase = async (name: string): Promise<Result<ScratchDatabase, ScratchDatabaseError>> => {
  // `CREATE DATABASE` and `DROP DATABASE` take no bound parameters, so the name
  // is interpolated. It is checked rather than trusted: this is the one place in
  // the suite that issues a `DROP DATABASE`, and "it is only test code" is not a
  // property of the statement that runs.
  const quoted = quotedDatabaseName(name);
  if (!quoted.ok) return quoted;
  const adminUrl = process.env.OAKRIDGE_TEST_DATABASE_URL ?? DEV_STACK_ADMIN_URL;
  if (!(await isReachable(adminUrl))) {
    return { ok: false, error: { operation: "reach_admin_endpoint", database_name: name, detail: `no PostgreSQL accepting connections at ${adminUrl}` } };
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const admin = PgPostgresExecutor.connect(adminUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoted.value}`, []);
    await admin.query(`CREATE DATABASE ${quoted.value}`, []);
  } catch (error) {
    return { ok: false, error: { operation: "create_scratch_database", database_name: name,
      detail: error instanceof Error ? error.message : String(error) } };
  } finally {
    await admin.close();
  }
  return {
    ok: true,
    value: {
      url: url.toString(),
      async drop() {
        const cleanup = PgPostgresExecutor.connect(adminUrl);
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS ${quoted.value}`, []);
        } finally {
          await cleanup.close();
        }
      },
    },
  };
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
