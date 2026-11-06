# Observation operations

The observation service stores its own PostgreSQL data and captures Oakridge work. Oakridge remains the
workflow authority, and grading never decides a workflow. Start the service with
`OBSERVATION_DATABASE_URL` and `bun run --filter observation start`; it binds to `127.0.0.1:8791` unless
`OBSERVATION_HOST` or `OBSERVATION_PORT` is set. `scripts/oakridge-start --observation` starts it
alongside DBOS and kbbl and reads its settings from `observation/.env`; the script stops before starting
anything when that file names no database. Without the flag the service is not started.

The service captures and serves reads. It runs no grading worker and has no route that calls a provider.

## Credentials

Configure `OBSERVATION_INGEST_CREDENTIALS` as a JSON array of
`{"producer":"oakridge","namespace":"development","token":"<secret>"}` entries. Give DBOS the matching
`OAKRIDGE_OBSERVATION_NAMESPACE`, `OAKRIDGE_OBSERVATION_INGEST_TOKEN` and `OAKRIDGE_OBSERVATION_URL`.
DBOS does not construct the publisher when the URL is absent. With `--observation`, the start script
wires both sides itself and keeps one ingest token in `~/.local/state/oakridge/observation-ingest.token`.

An ingest token may only submit to and read the cursor of its configured producer and namespace.
`OBSERVATION_READ_CREDENTIALS` and `OBSERVATION_GRADE_CREDENTIALS` are separate tenant-bound arrays, and
tokens must be unique across all three. Each grade credential needs a `reviewer_id`, the identity stored
on answers made with that token. Keep credentials in `observation/.env`, outside checked-in
configuration and logs. Rotation means replacing the configuration and restarting the service and
publisher together.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OBSERVATION_DATABASE_URL` | yes | The service's PostgreSQL database. |
| `OBSERVATION_INGEST_CREDENTIALS` | to capture | Supplied by the start script with `--observation`. |
| `OBSERVATION_READ_CREDENTIALS` | to read | Items, lineage, grades, questions and evidence. |
| `OBSERVATION_GRADE_CREDENTIALS` | to grade | As above, with `reviewer_id`. |
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

## Failure modes

The publisher never enters commit, step or effect execution. An observation outage leaves workflow
progress untouched: delivery resumes from the service-held cursor after either side restarts, and
committed events are replayed in order. A transaction holding a lower commit id holds back the whole
tail until it finishes, so delivery is never reordered.
