#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
output="$root/oakridge-dbos/src/core-client/generated-contracts.ts"
source_output="$root/kbbl/core/pwa/oakridge/workflow-definition-types.ts"
builder_output="$root/workflow-config/src/source-contracts.ts"
generated="$(mktemp)"
generated_source="$(mktemp)"
trap 'rm -f "$generated" "$generated_source"' EXIT
cargo run --locked --manifest-path "$root/workflow-core/Cargo.toml" -p workflow-cli -- --generate-contracts > "$generated"
cargo run --locked --manifest-path "$root/workflow-core/Cargo.toml" -p workflow-cli -- --generate-source-contracts > "$generated_source"
if [[ "${1:-}" == "--check" ]]; then
  diff -u "$output" "$generated"
  diff -u "$source_output" "$generated_source"
  diff -u "$builder_output" "$generated_source"
  bun "$root/kbbl/scripts/generate-operator-contracts.ts" --check
else
  cp "$generated" "$output"
  cp "$generated_source" "$source_output"
  cp "$generated_source" "$builder_output"
  bun "$root/kbbl/scripts/generate-operator-contracts.ts"
fi
