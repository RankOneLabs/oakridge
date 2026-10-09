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
# Shipped bundles are generated, not committed.
bash "$(dirname "$0")/../../scripts/generate-bundles.sh"
# Booting a composition requires an effect-encryption key, and CI supplies none.
# Default one for the whole suite so a new test that boots the authority cannot
# omit it; production-effects.test.ts still unsets it at runtime to assert that a
# missing key fails startup.
export OAKRIDGE_EFFECT_ENCRYPTION_KEY="${OAKRIDGE_EFFECT_ENCRYPTION_KEY:-ERERERERERERERERERERERERERERERERERERERERERE}"
integration=' advance-children authority-schema cancellation-obligations capacity-reservations child-page commit-atomicity concurrent-decisions crash-matrix development-lifecycle development-publication effect-deadline engine-upgrade fresh-boot launch-postgres operator-browser ops-live production-effects provider-driven-bundles receipt-replay rejection-reasons retained-operations review-effects run-durability run-error-recovery run-review-acceptance run-rollover session-observe-recovery scope-command-postgres snapshot-reader stage-publications start-attempt-recovery '
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
  OAKRIDGE_ENABLE_RAW_INGRESS=1 bun test --timeout=30000 "${selected[index]}" || failed=$((failed+1))
done
if [[ "$failed" -ne 0 ]]; then echo "$failed $suite test files failed" >&2; exit 1; fi
