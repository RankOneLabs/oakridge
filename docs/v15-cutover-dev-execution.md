# v15 dev cutover execution

Executed on 2026-09-29 against the isolated PostgreSQL database
`oakridge_v15_cutover_dev` in the managed development instance.

The active `oakridge` database was not the cutover target because it contains
the work order authorizing this cohort and the capability required to publish
its result. Resetting that database before publication would irreversibly erase
the control-plane record. The isolated database had no attached workers, so it
was write-free for the complete dump, reset, migration, and seed sequence.

## Backup

- Location: `willie:/srv/oakridge/backups/v15/oakridge-v15-cutover-dev-pre-v15-20260929T174747Z.dump`
- Format: PostgreSQL custom archive
- Size: 115815 bytes
- SHA-256: `cc12b3b95d5bbb6c646d5cb0443b0085b983d9a2395e497c93d7829d9cd93554`
- Remote non-empty-file and checksum verification: passed before reset

The isolated database was initialized with the active dev schema and no data;
the dump therefore records the exact pre-cutover structure without copying the
active control-plane rows.

## Cutover result

The runbook reset removed `oakridge`, `dbos`, and
`public.oakridge_schema_migration`. Migration then applied:

- `0015_v15_baseline.sql`
- `0016_dev_flow_pull_requests.sql`

Production `seedBuiltins` was run twice through `BunPostgresExecutor`. Both
runs completed. The resulting database contains one `dev-flow` v15 definition,
six stages, and an 18-cell prompt bundle.

## Boot limitation

Starting `oakridge-dbos/src/main.ts` against the cutover database reaches the
existing runtime composition guard and exits with:

```text
Oakridge v15 runtime composition is unavailable until cohort c8
```

The guard is in `oakridge-dbos/src/runtime/compose.ts`, outside this cohort's
file scope. Migration and first/second-boot seeding were therefore verified
directly through the same production storage and seed implementations, while a
full HTTP process boot remains blocked on runtime composition.
