# Oakridge v15 storage cutover

The v15 migration is a destructive baseline. It has no upgrade path from the
22-file schema and no application code reads the backup. The backup preserves
the provenance of old run IDs and cited artifacts.

Run these commands from the Oakridge checkout on the application host. The
always-on hub is `willie`; dumps live at
`willie:/srv/oakridge/backups/v15/`. Replace the service commands only when the
deployment uses a different supervisor.

Before starting, put Oakridge in write-free maintenance mode: prevent new work
from being admitted and wait for every in-flight database writer to finish.
Keep that condition in place from before `pg_dump` until the workers are
stopped. This preserves the required dump-before-stop sequence without allowing
writes after the dump snapshot.

```bash
set -euo pipefail
dump_name="oakridge-pre-v15-$(date -u +%Y%m%dT%H%M%SZ).dump"
dump_path="/srv/oakridge/backups/v15/${dump_name}"

ssh willie "mkdir -p /srv/oakridge/backups/v15"
pg_dump --format=custom --no-owner --no-privileges "$OAKRIDGE_DATABASE_URL" \
  | ssh willie "cat > '${dump_path}'"
ssh willie "test -s '${dump_path}'"
printf 'willie:%s\n' "$dump_path" > oakridge-dbos/src/storage/v15-baseline-dump-path.txt

systemctl --user stop oakridge-dbos

psql "$OAKRIDGE_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS oakridge CASCADE;
DROP SCHEMA IF EXISTS dbos CASCADE;
DROP TABLE IF EXISTS public.oakridge_schema_migration;
SQL

bun --cwd oakridge-dbos run migrate
systemctl --user start oakridge-dbos
```

Do not proceed past `pg_dump` until the remote `test -s` succeeds and
`v15-baseline-dump-path.txt` contains the full `willie:` path. The committed
baseline remains the only SQL file in `src/storage/migrations/`; the path file
sits beside that directory so migration discovery cannot mistake it for SQL.

`tests/support/dev-flow-harness.ts` performs the same stop/drop/apply/start
sequence on every end-to-end boot. Its process has no workers before setup; it
drops `oakridge`, `dbos`, and the migration ledger, applies the baseline, then
launches DBOS.
