#!/usr/bin/env bash
set -euo pipefail

# To re-baseline the v1 UI, deliberately update this SHA and its frozen path
# list in the same reviewed change that updates the corresponding UI files.
FROZEN_BASE=7b341250412e871973716c92f53c4a78753a032a
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
