# Oakridge v2 DBOS Operator Runbook

This is the operating guide for the current Oakridge v2 stack. The active
workflow substrate is the TypeScript service in `oakridge-dbos/`. The Rust
`oakridge-core/` tree is retained as reference material and is not part of the
startup path.

## Runtime ownership

| Component | Default address | Responsibility |
| --- | --- | --- |
| kbbl | `http://127.0.0.1:8788` | Operator PWA, same-origin DBOS proxy, interactive CLI-agent sessions |
| Oakridge DBOS | `http://127.0.0.1:8790` | Workflow definitions, durable workflows, stages, artifacts, gates, recovery, projections |
| PostgreSQL | `127.0.0.1:54329` | Oakridge domain schema and DBOS system state |

DBOS owns scheduling, runtime cardinality, fan-out/fan-in, durable waits,
recovery, and workflow history. Oakridge owns the domain contracts and read
models. StageInstance records only start and finish lifecycle; it is not coupled
to kbbl sessions or any other executor mechanism.

## Prerequisites

- Bun and Git.
- Docker with a running daemon, unless `DBOS_SYSTEM_DATABASE_URL` points to an
  existing PostgreSQL database.
- Claude Code authentication available to kbbl for the current
  `delegated_session` executor.

Install workspace dependencies once after cloning or changing the lockfile:

```bash
bun install
```

## Start the complete local stack

From the repository root:

```bash
bun run oakridge
```

The launcher creates or starts `oakridge-postgres` when it owns the database,
waits for readiness, applies migrations, starts DBOS on loopback, and rebuilds
and starts kbbl. Open:

```text
http://127.0.0.1:8788/#oakridge
```

Ctrl-C stops kbbl and DBOS. PostgreSQL stays running so workflow state survives
application restarts. To stop the managed database separately:

```bash
docker stop oakridge-postgres
```

The data remains in the `oakridge-postgres-data` Docker volume. Removing that
volume deletes workflow and domain state and is intentionally not part of the
launcher.

### Existing PostgreSQL

Set the database URL before starting; the launcher will not create or manage a
container:

```bash
export DBOS_SYSTEM_DATABASE_URL=postgres://user:password@127.0.0.1:5432/oakridge
bun run oakridge
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DBOS_SYSTEM_DATABASE_URL` | managed local container | Existing PostgreSQL connection URL |
| `DBOS_APPLICATION_VERSION` | current Git commit | DBOS application version for workflow routing |
| `OAKRIDGE_DBOS_HOST` | `127.0.0.1` | DBOS HTTP bind address |
| `OAKRIDGE_DBOS_PORT` | `8790` | DBOS HTTP port |
| `OAKRIDGE_POSTGRES_CONTAINER` | `oakridge-postgres` | Managed container name |
| `OAKRIDGE_POSTGRES_PORT` | `54329` | Managed host port |
| `OAKRIDGE_POSTGRES_IMAGE` | `postgres:16` | Managed image |
| `KBBL_PORT` | `8788` | kbbl HTTP port |

The launcher supplies `KBBL_BASE_URL` to DBOS and
`OAKRIDGE_CORE_BASE_URL` to kbbl. The latter name is retained for kbbl
compatibility; it points to DBOS.

## Start services separately

Use separate terminals when debugging one boundary.

```bash
# Terminal 1
cd oakridge-dbos
export DBOS_SYSTEM_DATABASE_URL=postgres://oakridge:oakridge@127.0.0.1:54329/oakridge
export DBOS_APPLICATION_VERSION="$(git rev-parse HEAD)"
export KBBL_BASE_URL=http://127.0.0.1:8788
export OAKRIDGE_DBOS_HOST=127.0.0.1
export PORT=8790
bun run migrate
bun run start
```

```bash
# Terminal 2, from the repository root
OAKRIDGE_CORE_BASE_URL=http://127.0.0.1:8790 \
  ./kbbl/scripts/kbbl-start /absolute/path/to/default/repository
```

## Start and operate a run

1. Open `#oakridge` and choose **New Run**.
2. Select the seeded `dev-flow v11` definition.
3. Select or create a project and confirm repository bindings.
4. Enter the Epic brief and select planner/worker runtime configuration.
5. Start the run.

The PWA sends a client-owned idempotency key and retains it across an uncertain
launch retry. A retry of the unchanged form converges on the same logical run;
an intentional new submission after confirmed success receives a new identity.

The standard flow is:

```text
spec → plan → build (runtime-N children) → assessment/gates → review/final integration
```

DBOS owns child cardinality and completion. Oakridge artifacts are immutable
revision chains in adjacent domain tables. Only the current unreleased revision
is actionable; correction supersedes the prior revision and durably closes its
gate or handoff wait.

## Gates, collaboration, and correction

- Gate actions are durable DBOS commands. A pending gate survives process and
  machine restarts as long as PostgreSQL survives.
- Collaboration thread ping starts a stable DBOS responder workflow. Oakridge
  validates the current artifact/thread and builds the domain prompt; the
  executor adapter delivers it. The path is not coupled to kbbl and can support
  a future headless adapter.
- Changed artifact emission creates the next revision and supersedes the prior
  current revision atomically.
- An erroneous current unreleased artifact can be withdrawn. Released artifacts
  require a stage or unit rerun rather than mutation.
- Unit retry forks the failed execution child. Whole-stage retry starts a new
  workflow attempt from persisted ancestor artifacts.

## Restart and recovery

Restart with the same command:

```bash
bun run oakridge
```

DBOS recovers workflows from PostgreSQL. kbbl executor sessions are addressed by
stable resumable keys, so executor steps attach or converge rather than creating
an app-owned scheduler.

`DBOS_APPLICATION_VERSION` defaults to the Git commit. Workflow code changes can
change durable operation order. Before deploying a new version, inspect
`/application_versions` for older versions that still own gated work. Keep the
old executor available until those runs drain, or explicitly cancel/rerun them.
Do not assign changed workflow code the same application version.

## Remote access

Keep DBOS and PostgreSQL on loopback. Expose only kbbl:

```bash
export OAKRIDGE_CONTROL_TOKEN="$(openssl rand -hex 32)"
bun run oakridge -- --host=0.0.0.0
```

Open `http://<machine-ip-or-tailnet-name>:8788/#oakridge`. The browser talks to
the DBOS backend through kbbl's same-origin `/oakridge/api/*` proxy.

For short-lived trusted-network development only:

```bash
ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 bun run oakridge -- --host=0.0.0.0
```

## Verification and troubleshooting

Check the backend through the same proxy the PWA uses:

```bash
curl -fsS http://127.0.0.1:8788/oakridge/config
curl -fsS http://127.0.0.1:8788/oakridge/api/workflow_defs
curl -fsS http://127.0.0.1:8788/oakridge/api/runs
```

Common failures:

- **Docker daemon is not running:** start Docker, or export a PostgreSQL URL.
- **Port 54329 is occupied:** set `OAKRIDGE_POSTGRES_PORT` before the first
  managed-container creation, or use an existing database URL.
- **PWA says Oakridge is unavailable:** confirm kbbl was started with
  `OAKRIDGE_CORE_BASE_URL=http://127.0.0.1:8790` and DBOS is listening.
- **Executor cannot attach:** confirm kbbl is on `:8788` and inspect the stable
  resumable session endpoint/logs.
- **Old gated run does not advance after a code update:** its DBOS application
  version may no longer have a live executor. Drain it with the old version or
  deliberately cancel/rerun it.

## Direct kbbl sessions

Standalone kbbl sessions remain supported and do not require DBOS:

```bash
./kbbl/scripts/kbbl-start /absolute/path/to/repository
```

They are session-first work and do not create Oakridge workflow runs, stages,
artifact contracts, gates, or DBOS history.
