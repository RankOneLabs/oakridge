#!/usr/bin/env python3
"""Generate lbc-dashboard/src/generated/task_catalog.ts from the Python registry.

Run from the legit-biz-club directory:
  uv run python scripts/generate_dashboard_metadata.py

CI drift check — after running, verify the committed file is up to date:
  git diff --exit-code ../lbc-dashboard/src/generated/task_catalog.ts
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
OUTPUT_PATH = REPO_ROOT / "lbc-dashboard" / "src" / "generated" / "task_catalog.ts"

sys.path.insert(0, str(SCRIPT_DIR.parent / "src"))

from legit_biz_club.study.registry import (  # noqa: E402
    GRADER_CATALOG,
    TASK_CATALOG_BY_NAME,
    TASK_FACTORIES,
)


def main() -> None:
    tasks = [_build_task_detail(key) for key in TASK_FACTORIES]
    graders = [_build_grader_summary(g) for g in GRADER_CATALOG]
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(_render(tasks, graders))
    print(f"wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")


def _build_task_detail(task_key: str) -> dict[str, object]:
    config = TASK_FACTORIES[task_key]()
    summary = TASK_CATALOG_BY_NAME[task_key]
    return {
        "name": config.name,
        "artifact_type": config.artifact_type.value,
        "artifact_filename": config.artifact_filename,
        "seed_content": config.seed_content,
        "brief": {
            "target_spec": config.brief.target_spec,
            "success_criteria": list(config.brief.success_criteria),
            "constraints": list(config.brief.constraints),
        },
        "model_pool": list(config.model_pool),
        "frame_pool": list(config.frame_pool),
        "has_grader": summary.has_grader,
        "grader_key": summary.grader_key,
        "source": "builtin",
    }


def _build_grader_summary(grader_meta) -> dict[str, object]:
    return {
        "key": grader_meta.key,
        "label": grader_meta.label,
        "supported_artifact_types": [at.value for at in grader_meta.supported_artifact_types],
        "capabilities": list(grader_meta.capabilities),
        "source": "builtin",
        "config_required": False,
        "config_schema": grader_meta.config_schema,
    }


def _render(tasks: list[dict[str, object]], graders: list[dict[str, object]]) -> str:
    tasks_json = json.dumps(tasks, indent=2)
    graders_json = json.dumps(graders, indent=2)
    return (
        "// AUTO-GENERATED — do not edit.\n"
        "// Source: legit-biz-club/scripts/generate_dashboard_metadata.py\n"
        "// Regenerate: cd legit-biz-club && uv run python scripts/generate_dashboard_metadata.py\n"
        "// CI drift: regenerate then"
        " `git diff --exit-code ../lbc-dashboard/src/generated/task_catalog.ts`.\n"
        'import type { TaskBuiltinDetail, GraderSummary } from "../contracts";\n'
        "\n"
        f"export const BUILTIN_TASK_DETAILS: readonly TaskBuiltinDetail[] = {tasks_json}"
        " as const satisfies readonly TaskBuiltinDetail[];\n"
        "\n"
        f"export const BUILTIN_GRADER_SUMMARIES: readonly GraderSummary[] = {graders_json}"
        " as const satisfies readonly GraderSummary[];\n"
    )


if __name__ == "__main__":
    main()
