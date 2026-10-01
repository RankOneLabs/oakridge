# Oakridge v15 storage cutover

The v15 migration is a destructive baseline. Run this procedure only after the
workflow refactor epic has merged and the operator has scheduled a write-free
maintenance window. Local development and end-to-end databases that recorded
the old 0015 migration must also be dropped once: migration now refuses a
ledger whose 0015 row does not describe its schema.

Oakridge on otto uses one PostgreSQL database for the application schema and
DBOS: `postgres://oakridge:oakridge@127.0.0.1:54329/oakridge`.
`scripts/oakridge-start` starts the managed PostgreSQL container, runs
`bun run migrate`, and serves the API. Record the exact PID of that script
when launching it; this procedure sends SIGTERM to that PID only.

From the Oakridge checkout, prevent new admissions and wait for in-flight
database writes before taking the dump. Set `OAKRIDGE_START_PID` to the
captured PID of the currently running `scripts/oakridge-start` process.

```bash
set -euo pipefail
oakridge_start_pid="${OAKRIDGE_START_PID:?set the captured scripts/oakridge-start PID}"
dump_name="oakridge-pre-v15-$(date -u +%Y%m%dT%H%M%SZ).dump"
dump_path="/srv/oakridge/backups/v15/${dump_name}"

ssh willie "mkdir -p /srv/oakridge/backups/v15"
docker exec oakridge-postgres pg_dump -U oakridge -d oakridge -Fc \
  | ssh willie "cat > '${dump_path}'"
ssh willie "test -s '${dump_path}'"
printf 'willie:%s\n' "$dump_path" > oakridge-dbos/src/storage/v15-baseline-dump-path.txt

kill -TERM "$oakridge_start_pid"
while kill -0 "$oakridge_start_pid" 2>/dev/null; do sleep 1; done

docker exec -i oakridge-postgres psql -U oakridge -d oakridge -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS oakridge CASCADE;
DROP SCHEMA IF EXISTS dbos CASCADE;
DROP TABLE IF EXISTS public.oakridge_schema_migration;
SQL

scripts/oakridge-start &
oakridge_start_pid=$!
printf 'Oakridge start PID: %s\n' "$oakridge_start_pid"
```

Do not stop the running process until the remote `test -s` succeeds and
`v15-baseline-dump-path.txt` contains the full `willie:` path. The baseline
is the only SQL file in `src/storage/migrations/`. Keep admission paused until
the restarted HTTP API serves requests and the operator releases maintenance.
