# Usage analysis with DuckDB

The run detail Usage panel answers routine cost and time questions. For ad hoc
analysis, DuckDB can join the two stores without copying telemetry into Postgres.
Use a consistent snapshot or a quiet run if you need repeatable results across
both databases.

Start DuckDB from the repository root. The kbbl ledger defaults to
`kbbl/data/kbbl.db`; if the server was started with `--dataDir`, use `kbbl.db`
inside that directory instead. The DBOS connection string is the deployment's
`DBOS_SYSTEM_DATABASE_URL`. Obtain it from your deployment configuration and use
a read-only database account; avoid saving credentials in SQL history or shared
scripts.

```sql
INSTALL sqlite;
LOAD sqlite;
INSTALL postgres;
LOAD postgres;

ATTACH 'kbbl/data/kbbl.db' AS kbbl (TYPE sqlite, READ_ONLY);
```

Attach Postgres with your deployment connection string in place of the quoted
connection-string description below. Both attachments must retain `READ_ONLY`.

```sql
ATTACH '<postgres connection string>' AS dbos (TYPE postgres, READ_ONLY);

SELECT a.run_id, a.unit_id, a.action_id, a.seq,
       t.sid, t.turn_key, u.status,
       u.input_tokens, u.output_tokens, u.total_tokens
FROM dbos.authority.attempt AS a
JOIN kbbl.acp_turns AS t
  ON a.kbbl_session_id = t.sid
 AND t.turn_key = sha256(a.action_id || chr(0) || CAST(a.seq AS VARCHAR))
LEFT JOIN kbbl.acp_turn_usage AS u
  ON u.sid = t.sid AND u.turn_key = t.turn_key;
```

The SHA-256 result is hexadecimal, matching the agent delivery key. This exact
match covers delivered turns only. Other turns on a shared or resumed session
(operator steering, collaboration, and `initial:<key>` preambles) are attributed to the
most recent delivered turn that started at or before their start time (or
creation time). Before any delivery starts, they fall back to the first attempt
holding the session. The usage endpoint applies these rules. Use the endpoint for complete attributed
run totals rather than treating this delivered-turn query as complete coverage.

Usage rows with status `absent` have null counts. Count these rows explicitly,
for example with `count(*) FILTER (WHERE u.status = 'absent')`; do not turn their
counts into zero. A missing usage row from the left join is also missing
telemetry, rather than proof of zero usage.

USD in `kbbl.acp_usage_reading.cost_amount` (where `cost_currency = 'USD'`) is
**list-price equivalent**, not a subscription invoice charge. These readings are
cumulative within an agent process: summing readings overcounts cost. Use the
endpoint's cost deltas for run figures. Verification USD comes from observation
and is **provider charged**.
