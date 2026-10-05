#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
output="$root/oakridge-dbos/src/core-client/generated-contracts.ts"
generated="$(mktemp)"
trap 'rm -f "$generated"' EXIT
cargo run --locked --manifest-path "$root/workflow-core/Cargo.toml" -p workflow-cli -- --generate-contracts > "$generated"
if [[ "${1:-}" == "--check" ]]; then
  diff -u "$output" "$generated"
else
  cp "$generated" "$output"
fi
