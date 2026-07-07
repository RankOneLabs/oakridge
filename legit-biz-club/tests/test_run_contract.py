"""RESULT-line contract tests for legit_biz_club.run.

Validates the stdout interface that oakridge-core's DelegatedLbcRunStage
consumes when it bridges ``python -m legit_biz_club.run``:

  - Exactly one ``RESULT <json>`` line on stdout.
  - The JSON object contains ``artifact_path`` (non-empty string) and
    ``eval_scores`` (list when graded, null when grade: false).
  - Sidecar durability: ``events.jsonl`` exists in the cell directory
    before RESULT is emitted (because the event tee is wired before
    run_cell returns, and any in-process emit call flushes synchronously).
  - Failure: non-zero exit code, no RESULT line emitted.

Tests run at captured-stdout level (calling ``main()`` directly with
``redirect_stdout``) to avoid real LLM or grader calls while still
exercising the full entrypoint path from spec parsing through RESULT
emission. The subprocess failure test uses a real process invocation
because the failure path is exercised by spec validation, which does
not require LLM mocking.
"""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from legit_biz_club.run import main

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_local_task(local_task_dir: Path, name: str) -> None:
    local_task_dir.mkdir(parents=True, exist_ok=True)
    task: dict[str, object] = {
        "name": name,
        "artifact_type": "prose",
        "artifact_filename": "draft.md",
        "seed_content": "initial draft",
        "brief": {
            "target_spec": "write a contract test document",
            "success_criteria": ["document exists"],
        },
        "model_pool": ["claude-sonnet-4-5"],
    }
    (local_task_dir / f"{name}.json").write_text(json.dumps(task), encoding="utf-8")


def _write_spec(
    spec_path: Path,
    task_name: str,
    local_task_dir: Path,
    *,
    grade: bool = False,
) -> None:
    spec: dict[str, object] = {
        "task": task_name,
        "model_pool": ["claude-sonnet-4-5"],
        "condition": {"kind": "single_agent", "n": 1},
        "grade": grade,
        "local_task_dir": str(local_task_dir),
    }
    spec_path.write_text(json.dumps(spec), encoding="utf-8")


def _make_fake_run_cell(grade: bool = False):
    """Return an async stub for ``run_cell`` that avoids any LLM call.

    The stub:
      1. Creates the cell directory and artifact file.
      2. Calls ``emit`` once so ``events.jsonl`` is flushed to disk before
         the caller checks for sidecar durability.
      3. Returns a MagicMock whose ``artifact_path`` and ``eval_scores``
         mirror what ``main()`` reads from a real ``CellResult``.
    """
    async def _fake_run_cell(
        *,
        target,
        condition,
        output_dir: Path,
        emit=None,
        **_kwargs,
    ):
        cell_dir = output_dir / target.name / condition.name
        cell_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = cell_dir / target.artifact_filename
        artifact_path.write_text("stub artifact content", encoding="utf-8")
        if emit is not None:
            await emit("stub_event", {"msg": "contract-test stub"})
        result = MagicMock()
        result.artifact_path = artifact_path
        result.grading_error = None  # prevents the grading_error guard in main()
        if grade:
            score = MagicMock()
            score.dimension = "clarity"
            score.value = 0.85
            score.source.value = "llm"
            result.eval_scores = [score]
        else:
            result.eval_scores = []
        return result

    return _fake_run_cell


async def _run_main_captured(spec_path: Path, output_dir: Path, *, grade: bool = False) -> str:
    """Patch run_cell, call main(), and return captured stdout."""
    captured = io.StringIO()
    fake = _make_fake_run_cell(grade=grade)
    with patch("legit_biz_club.run.run_cell", new=fake), contextlib.redirect_stdout(captured):
        await main(str(spec_path), str(output_dir))
    return captured.getvalue()


def _result_lines(output: str) -> list[str]:
    return [line for line in output.strip().splitlines() if line.startswith("RESULT ")]


def _parse_result(line: str) -> dict[str, object]:
    return json.loads(line[len("RESULT "):])


# ---------------------------------------------------------------------------
# Success path: grade=False → eval_scores is null
# ---------------------------------------------------------------------------


async def test_success_emits_exactly_one_result_line(tmp_path: Path) -> None:
    task_name = "contract_task_a"
    local_task_dir = tmp_path / "tasks"
    _write_local_task(local_task_dir, task_name)
    spec_path = tmp_path / "spec.json"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_spec(spec_path, task_name, local_task_dir)

    output = await _run_main_captured(spec_path, output_dir)
    lines = _result_lines(output)
    assert len(lines) == 1, f"expected 1 RESULT line, got {len(lines)}: {output!r}"


async def test_success_result_json_has_artifact_path(tmp_path: Path) -> None:
    task_name = "contract_task_b"
    local_task_dir = tmp_path / "tasks"
    _write_local_task(local_task_dir, task_name)
    spec_path = tmp_path / "spec.json"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_spec(spec_path, task_name, local_task_dir)

    output = await _run_main_captured(spec_path, output_dir)
    payload = _parse_result(_result_lines(output)[0])
    assert "artifact_path" in payload, "RESULT JSON must contain artifact_path"
    assert isinstance(payload["artifact_path"], str) and payload["artifact_path"], (
        "artifact_path must be a non-empty string"
    )


async def test_success_result_artifact_path_file_exists(tmp_path: Path) -> None:
    task_name = "contract_task_c"
    local_task_dir = tmp_path / "tasks"
    _write_local_task(local_task_dir, task_name)
    spec_path = tmp_path / "spec.json"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_spec(spec_path, task_name, local_task_dir)

    output = await _run_main_captured(spec_path, output_dir)
    payload = _parse_result(_result_lines(output)[0])
    artifact_path = Path(str(payload["artifact_path"]))
    assert artifact_path.exists(), f"artifact file must exist at {artifact_path}"


async def test_grade_false_emits_eval_scores_null(tmp_path: Path) -> None:
    task_name = "contract_task_d"
    local_task_dir = tmp_path / "tasks"
    _write_local_task(local_task_dir, task_name)
    spec_path = tmp_path / "spec.json"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_spec(spec_path, task_name, local_task_dir, grade=False)

    output = await _run_main_captured(spec_path, output_dir, grade=False)
    payload = _parse_result(_result_lines(output)[0])
    assert payload["eval_scores"] is None, (
        "grade: false must produce eval_scores: null in RESULT JSON"
    )


# ---------------------------------------------------------------------------
# Success path: grade=True → eval_scores is a list
# ---------------------------------------------------------------------------


async def test_grade_true_emits_eval_scores_as_list(tmp_path: Path) -> None:
    """With grade: true, RESULT.eval_scores must be a list (not null)."""
    # Use a registered task so resolve_grader() succeeds without specifying
    # a grader ref. run_cell is stubbed so no real grader is invoked.
    spec: dict[str, object] = {
        "task": "prose_substrate_thesis",
        "model_pool": ["claude-sonnet-4-5"],
        "condition": {"kind": "single_agent", "n": 1},
        "grade": True,
    }
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    output = await _run_main_captured(spec_path, output_dir, grade=True)
    payload = _parse_result(_result_lines(output)[0])
    assert isinstance(payload["eval_scores"], list), (
        "grade: true must produce eval_scores as a list in RESULT JSON"
    )
    assert len(payload["eval_scores"]) == 1
    score = payload["eval_scores"][0]
    assert score["dimension"] == "clarity"
    assert score["value"] == pytest.approx(0.85)
    assert score["source"] == "llm"


# ---------------------------------------------------------------------------
# Sidecar durability: events.jsonl exists before RESULT emission
# ---------------------------------------------------------------------------


async def test_events_jsonl_sidecar_exists_when_result_emitted(tmp_path: Path) -> None:
    """events.jsonl must be written before the RESULT line appears on stdout.

    The event tee is wired inside main() before run_cell() is called.
    Our stub calls emit() once during run_cell, flushing at least one
    JSONL record. The RESULT line is printed after run_cell returns, so
    events.jsonl is guaranteed to exist (and contain valid JSONL) when
    oakridge-core reads it.
    """
    task_name = "contract_task_e"
    local_task_dir = tmp_path / "tasks"
    _write_local_task(local_task_dir, task_name)
    spec_path = tmp_path / "spec.json"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _write_spec(spec_path, task_name, local_task_dir)

    await _run_main_captured(spec_path, output_dir)

    # cell_dir mirrors what main() computes:
    # Path(output_dir) / target.name / condition.name
    # → output_dir / "contract_task_e" / "single_agent"
    events_path = output_dir / task_name / "single_agent" / "events.jsonl"
    assert events_path.exists(), (
        f"events.jsonl sidecar must exist before RESULT emission; not found at {events_path}"
    )
    lines = events_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 1, "events.jsonl must contain at least one record"
    record = json.loads(lines[0])
    assert set(record.keys()) >= {"ts", "kind", "payload"}, (
        "events.jsonl record must have ts, kind, payload keys"
    )


# ---------------------------------------------------------------------------
# Failure: non-zero exit, no RESULT line
# ---------------------------------------------------------------------------


def test_invalid_spec_exits_nonzero_with_no_result_line(tmp_path: Path) -> None:
    """A malformed spec must cause a non-zero exit and no RESULT line.

    oakridge-core's bridge treats any non-zero exit as a terminal failure
    (kind: "non_zero_exit"). The RESULT line must be absent so the bridge
    cannot accidentally parse a partial or error message as a valid result.
    """
    spec_path = tmp_path / "bad_spec.json"
    spec_path.write_text(json.dumps({"invalid": "spec"}), encoding="utf-8")
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "legit_biz_club.run",
            "--spec",
            str(spec_path),
            "--output-dir",
            str(output_dir),
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0, (
        f"invalid spec must cause non-zero exit, got {result.returncode}"
    )
    result_lines = [
        line for line in result.stdout.splitlines() if line.startswith("RESULT ")
    ]
    assert len(result_lines) == 0, (
        f"no RESULT line must appear on failure stdout, got: {result.stdout!r}"
    )


def test_missing_spec_file_exits_nonzero_with_no_result_line(tmp_path: Path) -> None:
    """A non-existent spec path must produce non-zero exit and no RESULT line."""
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "legit_biz_club.run",
            "--spec",
            str(tmp_path / "nonexistent.json"),
            "--output-dir",
            str(output_dir),
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    result_lines = [
        line for line in result.stdout.splitlines() if line.startswith("RESULT ")
    ]
    assert len(result_lines) == 0
