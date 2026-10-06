#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
bun "$root/workflow-config/src/generate.ts" "$@"
