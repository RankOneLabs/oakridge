#!/usr/bin/env bash
set -euo pipefail
suite="${1:-}"
if [[ "$suite" != unit && "$suite" != integration ]]; then
  echo "choose unit or integration" >&2
  exit 2
fi
if [[ "$suite" == integration && -z "${OAKRIDGE_TEST_DATABASE_URL:-}" ]]; then
  echo "OAKRIDGE_TEST_DATABASE_URL is required for test:integration" >&2
  exit 2
fi
# Integration files run against a real PostgreSQL server: each creates and drops its own scratch database.
integration=' carrier-stop collaboration-store commit commit-atomicity concurrent-decisions event-stream executor-store fresh-boot migrate operator-registry ops-live read-store registry-store run-deletion '
mapfile -d '' files < <(find src tests -name '*.test.ts' -print0 | sort -z)
selected=()
for file in "${files[@]}"; do
  name="${file##*/}"
  name="${name%.test.ts}"
  if [[ "$integration" == *" $name "* ]]; then kind=integration; else kind=unit; fi
  if [[ "$kind" == "$suite" ]]; then selected+=("$file"); fi
done
if [[ ${#selected[@]} -eq 0 ]]; then echo "empty $suite suite" >&2; exit 2; fi
shard="${TEST_SHARD:-0}"
count="${TEST_SHARD_COUNT:-1}"
failed=0
for ((index=shard; index<${#selected[@]}; index+=count)); do
  bun test --timeout=120000 "${selected[index]}" || failed=$((failed+1))
done
if [[ "$failed" -ne 0 ]]; then echo "$failed $suite test files failed" >&2; exit 1; fi
