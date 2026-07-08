"""Tests for legit_biz_club.study.layout.

Verifies:
- RESERVED_SIDECAR_NAMES contains the expected canonical names.
- is_reserved_sidecar_name returns True for canonical names and differently-cased
  variants (catches platform / casing gaps).
- is_reserved_sidecar_name returns False for a normal artifact filename.
- cell_dir_path derives the expected path from its three components.
- cell_dir_name returns the expected relative string.
- runner.py and run.py validation surfaces reject reserved names (and
  differently-cased variants) through the public code paths.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from legit_biz_club.core.models import Brief
from legit_biz_club.run import RunSpec
from legit_biz_club.study.layout import (
    RESERVED_SIDECAR_NAMES,
    cell_dir_name,
    cell_dir_path,
    is_reserved_sidecar_name,
)
from legit_biz_club.study.runner import run_cell
from legit_biz_club.study.targets import prose_task

# ---------------------------------------------------------------------------
# is_reserved_sidecar_name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(RESERVED_SIDECAR_NAMES))
def test_reserved_canonical_names_rejected(name: str) -> None:
    assert is_reserved_sidecar_name(name)


@pytest.mark.parametrize(
    "name",
    [
        "Events.jsonl",
        "EVENTS.JSONL",
        "Eval_Scores.json",
        "EVAL_SCORES.JSON",
        "Commits",
        "COMMITS",
        "Agent_Memory",
        "AGENT_MEMORY",
    ],
)
def test_reserved_names_rejected_case_insensitive(name: str) -> None:
    assert is_reserved_sidecar_name(name)


@pytest.mark.parametrize(
    "name",
    [
        "solution.py",
        "essay.md",
        "output.txt",
        "results.json",
        "myartifact.py",
    ],
)
def test_normal_artifact_names_allowed(name: str) -> None:
    assert not is_reserved_sidecar_name(name)


# ---------------------------------------------------------------------------
# RESERVED_SIDECAR_NAMES contents
# ---------------------------------------------------------------------------


def test_reserved_sidecar_names_contains_expected_entries() -> None:
    assert frozenset(
        {"commits", "agent_memory", "events.jsonl", "eval_scores.json"}
    ) == RESERVED_SIDECAR_NAMES


# ---------------------------------------------------------------------------
# cell_dir_path and cell_dir_name
# ---------------------------------------------------------------------------


def test_cell_dir_path_combines_components(tmp_path: Path) -> None:
    result = cell_dir_path(tmp_path, "my_target", "single_agent")
    assert result == tmp_path / "my_target" / "single_agent"


def test_cell_dir_name_returns_relative_string() -> None:
    assert cell_dir_name("my_target", "single_agent") == "my_target/single_agent"


# ---------------------------------------------------------------------------
# runner.py public surface rejects reserved artifact filenames
# ---------------------------------------------------------------------------

_BRIEF = Brief(
    target_spec="Write something.",
    success_criteria=["criterion"],
    constraints=[],
)


@pytest.mark.parametrize(
    "filename",
    [
        "events.jsonl",
        "Events.jsonl",
        "EVENTS.JSONL",
        "eval_scores.json",
        "Eval_Scores.json",
        "commits",
        "Commits",
        "agent_memory",
        "Agent_Memory",
    ],
)
@pytest.mark.asyncio
async def test_runner_rejects_reserved_artifact_filename(
    tmp_path: Path, filename: str
) -> None:
    from legit_biz_club.study.conditions import single_agent_baseline

    target = prose_task(
        name="test_target",
        artifact_filename=filename,
        seed_content="",
        brief=_BRIEF,
        model_pool=("claude-opus-4-5",),
    )
    condition = single_agent_baseline()

    with pytest.raises(ValueError, match="reserved sidecar"):
        await run_cell(
            target=target,
            condition=condition,
            proposer_factory=lambda agent, *, context="": _never_called(),
            output_dir=tmp_path,
        )


def _never_called() -> None:
    raise AssertionError("proposer_factory should not be called")


# ---------------------------------------------------------------------------
# run.py public surface rejects reserved artifact filenames via local task
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "filename",
    [
        "events.jsonl",
        "Eval_Scores.json",
        "Commits",
        "AGENT_MEMORY",
    ],
)
def test_run_spec_local_task_rejects_reserved_artifact_filename(
    tmp_path: Path, filename: str
) -> None:
    task_file = tmp_path / "my_task.json"
    task_file.write_text(
        json.dumps(
            {
                "name": "my_task",
                "artifact_type": "prose",
                "artifact_filename": filename,
                "brief": {
                    "target_spec": "Write something.",
                    "success_criteria": ["done"],
                },
                "model_pool": ["claude-opus-4-5"],
                "seed_content": "",
            }
        ),
        encoding="utf-8",
    )
    spec_data: dict[str, object] = {
        "task": "my_task",
        "model_pool": ["claude-opus-4-5"],
        "condition": {"kind": "single_agent", "n": 1},
        "grade": False,
        "local_task_dir": str(tmp_path),
    }
    with pytest.raises(ValueError, match="reserved sidecar"):
        RunSpec.from_dict(spec_data)
