#!/usr/bin/env bash
set -euo pipefail

# To re-baseline the v1 UI, deliberately update this SHA and its frozen path
# list in the same reviewed change that updates the corresponding UI files.
FROZEN_BASE=fbf65539941e751f6aff9509de262818a4d217ca
FROZEN_PATHS=(
  kbbl/core/pwa/oakridge/components/
  kbbl/core/pwa/oakridge/views/
  kbbl/core/pwa/oakridge/types.ts
  kbbl/core/pwa/oakridge/lib/
  kbbl/core/pwa/oakridge/queryKeys.ts
  kbbl/core/pwa/oakridge/artifactRegistry.tsx
  kbbl/core/pwa/oakridge/OakridgeShell.tsx
  kbbl/core/pwa/oakridge/repository-inputs.ts
)

cd "$(dirname "$0")/.."
git diff --exit-code "$FROZEN_BASE" -- "${FROZEN_PATHS[@]}"
