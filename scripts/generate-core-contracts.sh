#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
output="$root/oakridge-dbos/src/core-client/generated-contracts.ts"
generated="$(mktemp)"
source_schema="$(mktemp)"
trap 'rm -f "$generated" "$source_schema"' EXIT
cargo run --locked --manifest-path "$root/workflow-core/Cargo.toml" -p workflow-cli -- --generate-contracts > "$generated"
cargo run --locked --manifest-path "$root/workflow-core/Cargo.toml" -p workflow-cli -- --source-schema > "$source_schema"
if [[ "${1:-}" == "--check" ]]; then
  diff -u "$output" "$generated"
  diff -u "$root/workflow-core/fixtures/source-schema.json" "$source_schema"
else
  cp "$generated" "$output"
  cp "$source_schema" "$root/workflow-core/fixtures/source-schema.json"
fi
