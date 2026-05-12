"""Tests for safir-build CLI argparse and dispatch (stubbed pipeline)."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from builder.cli import _build_parser, _run


def _make_pipeline_result(short_circuited: bool = False) -> MagicMock:
    r = MagicMock()
    r.short_circuited = short_circuited
    r.trace_id = "trace-abc"
    r.error_step = "planner2" if short_circuited else None
    return r


def test_help_exits_zero(capsys) -> None:
    with pytest.raises(SystemExit) as exc:
        _build_parser().parse_args(["--help"])
    assert exc.value.code == 0


def test_parser_minimum_args() -> None:
    args = _build_parser().parse_args(["42"])
    assert args.task_id == 42
    assert args.models is None
    assert args.workdir is None
    assert args.dry_run is False
    assert args.permission_profile_id is None


def test_parser_all_flags(tmp_path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    args = _build_parser().parse_args(
        [
            "42",
            "--models", "opus,sonnet",
            "--workdir", str(tmp_path),
            "--dry-run",
            "--safir-base-url", "http://safir.test",
            "--permission-profile-id", "7",
        ]
    )
    assert args.task_id == 42
    assert args.models == "opus,sonnet"
    assert args.dry_run is True
    assert args.permission_profile_id == 7


@pytest.mark.asyncio
async def test_run_dispatches_to_pipeline(tmp_path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()

    mock_result = _make_pipeline_result()

    with (
        patch("builder.cli.run_build_pipeline", new=AsyncMock(return_value=mock_result)),
        patch("builder.cli.SafirClient") as mock_sc,
    ):
        instance = MagicMock()
        instance.aclose = AsyncMock()
        mock_sc.return_value = instance

        args = _build_parser().parse_args(["42", "--workdir", str(tmp_path)])
        code = await _run(args)
    assert code == 0


@pytest.mark.asyncio
async def test_run_missing_workdir_returns_1() -> None:
    args = _build_parser().parse_args(["42", "--workdir", "/nonexistent/path/xyz"])
    code = await _run(args)
    assert code == 1


@pytest.mark.asyncio
async def test_run_workdir_without_git_returns_1(tmp_path) -> None:
    args = _build_parser().parse_args(["42", "--workdir", str(tmp_path)])
    code = await _run(args)
    assert code == 1


@pytest.mark.asyncio
async def test_run_bad_models_returns_1(tmp_path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    args = _build_parser().parse_args(
        ["42", "--workdir", str(tmp_path), "--models", "a,b,c"]
    )
    code = await _run(args)
    assert code == 1


@pytest.mark.asyncio
async def test_run_pipeline_raises_returns_2(tmp_path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()

    with (
        patch(
            "builder.cli.run_build_pipeline",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ),
        patch("builder.cli.SafirClient") as mock_sc,
    ):
        instance = MagicMock()
        instance.aclose = AsyncMock()
        mock_sc.return_value = instance

        args = _build_parser().parse_args(["42", "--workdir", str(tmp_path)])
        code = await _run(args)
    assert code == 2
