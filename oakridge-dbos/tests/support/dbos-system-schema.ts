/**
 * Creates DBOS's own system schema (`dbos.workflow_status` and friends) in a
 * test database, without keeping a runtime up.
 *
 * `applyMigrations` owns the `oakridge` schema only; the `dbos` schema is
 * created by the SDK the first time a runtime launches against a database.
 * A test that reads or seeds `dbos.workflow_status` directly — session holds,
 * the launch sweep's "unstarted run" query — passes on a database some earlier
 * launch already prepared and fails on a fresh one with
 * `relation "dbos.workflow_status" does not exist`. The SDK's migration
 * (`ensureSystemDatabase`) is not reachable through the package's exports map,
 * so the supported way to run it is a launch, shut down again at once.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";

export const ensureDbosSystemSchema = async (databaseUrl: string): Promise<void> => {
  DBOS.setConfig({ name: "oakridge-test-system-schema", systemDatabaseUrl: databaseUrl, logLevel: "warn" });
  await DBOS.launch();
  await DBOS.shutdown();
};
