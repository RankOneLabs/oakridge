# Oakridge DBOS backend

TypeScript replacement for the custom Oakridge v2 Rust orchestration
substrate. DBOS owns workflow execution, durable waits, fan-out/fan-in,
recovery, and workflow history. Oakridge owns workflow definitions, stage and
artifact contracts, review policy, executor adapters, and operator read models.

## Run locally

The normal entry point is the repository-level launcher:

```bash
bun run oakridge
```

It manages local PostgreSQL when needed, applies migrations, and supervises this
backend with kbbl. Use the commands below only when running the backend
separately for debugging.

The backend and DBOS use the same PostgreSQL database. Oakridge tables live in
the `oakridge` schema; DBOS manages its own system schema.

```bash
export DBOS_SYSTEM_DATABASE_URL=postgres://oakridge:oakridge@localhost:5432/oakridge
export DBOS_APPLICATION_VERSION="$(git rev-parse HEAD)"
export KBBL_BASE_URL=http://127.0.0.1:8788
export OAKRIDGE_DBOS_HOST=127.0.0.1
export PORT=8790

bun run migrate
bun run start
```

Migration `0003_artifact_lifecycle.sql` intentionally refuses to guess
lifecycle for artifacts created by earlier spike builds. If that migration
finds artifact rows, preserve any evidence you need and reset the disposable
spike database before migrating.

Artifact emission uses canonical `PUT` (legacy `POST` remains compatible).
Changed content creates a new immutable revision and supersedes the prior
unreleased revision. Executors can withdraw the current unreleased revision
with `POST /artifacts/:artifact_id/withdraw`; released revisions require a
rerun instead.

`DBOS_APPLICATION_VERSION` is intentionally required. Do not reuse a version
after changing durable workflow-operation order. Keep executors for older
versions running until `/application_versions` shows that their gated work has
drained, or use an explicitly reviewed DBOS patch.

## Verify

```bash
bun test
bun run typecheck
```

The historical spike harnesses under `src/dev/` remain useful as narrow proofs;
the production entry point is `src/main.ts`. Operational guidance, including
application-version drain behavior, is in `../docs/oakridge-v2-runbook.md`.
