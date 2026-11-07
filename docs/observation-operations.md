# Observation operations

The observation service stores its own PostgreSQL data and captures Oakridge work. Oakridge remains the
workflow authority, and grading never decides a workflow. Start the service with
`OBSERVATION_DATABASE_URL` and `bun run --filter observation start`; it binds to `127.0.0.1:8791` unless
`OBSERVATION_HOST` or `OBSERVATION_PORT` is set. `scripts/oakridge-start --observation` starts it
alongside DBOS and kbbl and reads its settings from `observation/.env`. Without the flag the service is
not started. Nothing about workflows waits on it: see [Supervision and health](#supervision-and-health).

The service captures and serves reads. It runs no grading worker and has no route that calls a provider.

## Credentials

Configure `OBSERVATION_INGEST_CREDENTIALS` as a JSON array of
`{"producer":"oakridge","namespace":"development","token":"<secret>"}` entries. Give DBOS the matching
`OAKRIDGE_OBSERVATION_NAMESPACE`, `OAKRIDGE_OBSERVATION_INGEST_TOKEN` and `OAKRIDGE_OBSERVATION_URL`.
DBOS does not construct the publisher when the URL is absent. With `--observation`, the start script
wires every side itself: it keeps one token per capability in `observation-ingest.token`,
`observation-read.token` and `observation-grade.token` under `~/.local/state/oakridge`, generates each
once and reuses it, and overrides any `OBSERVATION_*_CREDENTIALS` in `observation/.env`. DBOS receives the
URL, namespace and ingest token. kbbl's server receives the URL, namespace and the read and grade tokens
as `OAKRIDGE_OBSERVATION_READ_TOKEN` and `OAKRIDGE_OBSERVATION_GRADE_TOKEN`; browsers still authenticate
with kbbl's own control policy, these tokens never reach a browser, and ACP agents inherit no `OAKRIDGE_*`
variable. The grade credential binds the reviewer `oakridge-operator`.

An ingest token may only submit to and read the cursor of its configured producer and namespace.
`OBSERVATION_READ_CREDENTIALS` and `OBSERVATION_GRADE_CREDENTIALS` are separate tenant-bound arrays, and
tokens must be unique across all three. Each grade credential needs a `reviewer_id`, the identity stored
on answers made with that token. Keep provider keys in `observation/.env`, outside checked-in
configuration and logs. Rotation means deleting the token file and restarting the stack, so every side
picks up the new value together.

Provider keys belong to the observation child alone. Each runner declares the settings it reads in
`runnerRegistry`, and both launchers remove every one of them from the environment of DBOS and kbbl.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OBSERVATION_DATABASE_URL` | yes | The service's PostgreSQL database. |
| `OBSERVATION_INGEST_CREDENTIALS` | to capture | Supplied by the start script with `--observation`. |
| `OBSERVATION_READ_CREDENTIALS` | to read | Items, lineage, grades, questions and evidence. Supplied likewise. |
| `OBSERVATION_GRADE_CREDENTIALS` | to grade | As above, with `reviewer_id`. Supplied likewise. |
| `OBSERVATION_HOST`, `OBSERVATION_PORT` | no | Bind address. |
| `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` | for `jev_direct` | Provider key and optional base URL. |
| `FASTINO_API_KEY`, `FASTINO_BASE_URL` | for `fastino_glide` | Provider key and optional base URL. |
| `OBSERVATION_LLM_JUDGE_API_KEY`, `OBSERVATION_LLM_JUDGE_BASE_URL` | for `llm_judge` | Provider key and optional base URL. |

Generate tokens with `openssl rand -hex 32`.

## Storage

The service creates its schema on an empty database and verifies the recorded baseline digest on
restart. It does not upgrade or adopt an older installation: a baseline change means provisioning a
fresh database. It refuses a database that already holds other tables, and PostgreSQL below 15.

Captured revision bodies and evidence references can hold prompts, repository content, and build and
test output. Restrict database access and avoid logging request bodies.

Every tenant-owned table forces row-level security on the transaction-local `observation.producer` and
`observation.namespace` settings, and every tenant reference is a composite foreign key. A superuser
bypasses row-level security, so run the service as an ordinary role. Answers, source revisions, item
occurrences and definitions refuse updates and deletes; there is no purge.

## Ordered capture

DBOS publishes `authority.event` in commit order through `POST /v1/sources/oakridge/events`. The service
stores each event's outcome and advances its cursor in one transaction, and the cursor it holds is
authoritative: the publisher reads it before each delivery. A repeated delivery is refused at the
cursor. A revision id names one immutable body, so a different body under the same id is refused and
holds the feed until an operator resolves it.

`launched` stores the run input as a `run_input` outcome, the durable source for the spec and
repositories. `revision_published` captures and projects a revision. `operator_decided` and the worker
events are `ignored`. An event the mapping cannot place is stored as `unmapped`; read those at
`GET /v1/sources/oakridge/unmapped`. The feed still advances past them.

`oakridge-dbos/scripts/observation-replay.ts` replays the committed stream into a scratch database and
reports whether delivery reaches the end of the stream. Run it before restarting a live install on new
code; nothing is written to the live databases.

## Isolated shadow

`scripts/oakridge-shadow --observation` is the only isolated observation setup; there is no other
launcher. It resolves `OAKRIDGE_SHADOW_STATE_DIR` once, passes that directory to `oakridge-start`, and
derives everything from it. `scripts/oakridge-shadow --print-state` prints the resolved state as JSON,
with no secrets, and starts nothing.

| What | Where |
| --- | --- |
| Database | `observation`, in the shadow's own PostgreSQL container and volume. |
| Role | `observation`, an ordinary role; its password is `observation-database.password` in the state directory. |
| Port | `OAKRIDGE_SHADOW_OBSERVATION_PORT`, default 8801. |
| Namespace | `shadow-<name>`. |
| Capabilities | `observation-{ingest,read,grade}.token` in the state directory, mode 600. |
| Child status | `observation-status.json` in the state directory. |
| Setup deadline | `OAKRIDGE_SHADOW_OBSERVATION_PREFLIGHT_SECONDS`, default 30. |

The first start creates the database empty and the service applies its baseline. Later starts reuse the
database and tokens, so scenarios and restarts share one state. To begin again, stop the shadow and remove
its container, volume and state directory. The launcher refuses a port that belongs to the default
install, including one `observation/.env` configures, that this shadow already uses, or that something
already answers on; DBOS would otherwise hand its ingest token to whatever is listening.

Every inherited `OAKRIDGE_*`, `DBOS_*`, `KBBL_*`, `OBSERVATION_*` and provider variable is dropped. The
observation child then starts in the state directory with `--no-env-file` and an environment of only
`PATH`, `HOME`, locale settings, its database URL, host, port, three credential lists and the selected
provider settings. DBOS and kbbl also run with `--no-env-file`, because Bun would otherwise load whatever
`.env` sits in the working directory.

`observation/scripts/provider-env.ts` reads provider settings from the real `observation/.env`, or
`OAKRIDGE_SHADOW_PROVIDER_ENV_FILE`, without loading or executing it. It selects the required and optional
settings of the runners named in `observation/graders.json` and nothing else. No `graders.json` means no
grader is configured and no setting is read.

## Supervision and health

Observation is a measurement service, so its failure is never a workflow failure. Its setup runs before DBOS and kbbl
start, under one deadline that also bounds each PostgreSQL statement and lock wait, so it can delay them by
at most that long. Only DBOS and kbbl
exiting ends the stack; observation runs under its own supervisor and an explicit stop still ends it with
everything else. It does not restart by itself: restart the stack to bring it back.

| Failure | Result |
| --- | --- |
| Missing configured key, unknown runner, unusable `graders.json` | The child is not started. |
| Shadow container mismatch or provisioning failure | The child is not started. |
| No `OBSERVATION_DATABASE_URL` for the default install | The child is not started. |
| Setup outlasting its deadline (PostgreSQL not answering, a lock that never frees) | The child is not started; the detail ends in `_timed_out`. |
| Startup failure or later exit | The exit status is recorded. |
| Hung HTTP | The child keeps running; health reports a timeout. |

In each case DBOS and kbbl keep serving, workflows keep progressing, the launcher logs the reason, and
`observation-status.json` holds `state` (`starting`, `preflight_failed`, `running`, `exited`, `stopped`)
and `detail`, which names settings and never values.

`GET /health` on the service is open and reports `database` and registered `graders`; it answers 503 when
the database is unavailable. `GET /health` on kbbl reports the component as `observation.state`, with a
2-second bound on the whole check:

| `observation.state` | Meaning |
| --- | --- |
| `not_configured` | This stack has no observation URL. |
| `down` | Not usable; `reason` is `unreachable`, `timeout`, `http_error`, `invalid_response` or `database_unavailable`. |
| `no_configured_graders` | The service is up and has registered no grader. |
| `configured` | The service reports these registered `graders`. |

kbbl answers 200 in all four, and `capabilities` reports whether it holds each token, never the value.
Health reflects what the service registered: a URL, token or open port proves nothing. The service
registers the graders `observation/graders.json` selects, so a healthy service reports them as
`configured`.

## Failure modes

The publisher never enters commit, step or effect execution. An observation outage leaves workflow
progress untouched: delivery resumes from the service-held cursor after either side restarts, and
committed events are replayed in order. A transaction holding a lower commit id holds back the whole
tail until it finishes, so delivery is never reordered.

## Production cutover

Run this only after the implementation work is finished. The development observation database was
already dumped and dropped, so its absence is not an error to repair, and no grading data is restored.

1. Stop the services.
2. Run `pg_dump` on `oakridge`, including workflow authority and DBOS state, to a file nothing in this
   repository reads. The old observation database needs no further dump.
3. Drop and recreate `oakridge` empty, and provision a fresh empty observation database for the target
   schema. The kbbl SQLite ACP ledger is separate and stays.
4. Deploy the core WASM, DBOS, observation and kbbl together.
5. Admit traffic after health and a smoke run pass.
