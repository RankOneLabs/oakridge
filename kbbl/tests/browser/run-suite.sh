#!/usr/bin/env bash
set -euo pipefail
shopt -s globstar nullglob

files=(./tests/browser/**/*.test.ts)
if (( ${#files[@]} == 0 )); then
  echo "No browser test files found" >&2
  exit 1
fi

# CI has reported truncated imports when Bun reuses a process across browser suites.
failed=0
for file in "${files[@]}"; do
  case "$file" in
    */fresh-start.integration.test.ts|*/portability-e2e.test.ts) continue ;;
  esac
  bun test "$file" || failed=1
done
exit "$failed"
