import argparse

import httpx
from safir_py import Plan, Task

import planner1.cli as cli
from planner1.cli import _build_parser
from planner1.staging import StagingBuffer


def test_parser_minimum_args():
    args = _build_parser().parse_args(["42"])
    assert args.task_id == 42
    assert args.model == "claude-opus-4-7"
    assert args.safir_base_url is None


def test_parser_model_override():
    args = _build_parser().parse_args(["42", "--model", "claude-sonnet-4-6"])
    assert args.model == "claude-sonnet-4-6"


def test_parser_safir_base_url_override():
    args = _build_parser().parse_args(["42", "--safir-base-url", "http://safir.test:7000"])
    assert args.safir_base_url == "http://safir.test:7000"


def _task(*, notes: str | None = "notes") -> Task:
    return Task(
        id=42,
        project_id="project-1",
        parent_id=None,
        title="Parent",
        notes=notes,
        status="active",
        priority=0,
        deadline=None,
        blocked_reason=None,
        created_at="2026-05-22T00:00:00Z",
        updated_at="2026-05-22T00:00:00Z",
        completed_at=None,
    )


def _plan() -> Plan:
    return Plan(
        id="plan-1",
        parent_task_id=42,
        summary="summary",
        model="model-1",
        status="pending_approval",
        rejection_reason=None,
        created_at="2026-05-22T00:00:00Z",
        updated_at="2026-05-22T00:00:00Z",
        cohorts=[],
        dependencies=[],
    )


def _args() -> argparse.Namespace:
    return argparse.Namespace(task_id=42, model="model-1", safir_base_url="http://safir.test")


def _install_fake_env(monkeypatch):
    monkeypatch.setattr(cli, "safir_base_url_from_env", lambda: "http://safir.test")
    monkeypatch.setattr(cli, "safir_api_token_from_env", lambda: "token")


async def test_run_returns_fetch_error_when_safir_get_task_fails(monkeypatch, capsys):
    _install_fake_env(monkeypatch)

    class FakeSafirClient:
        def __init__(self, *, base_url, api_token):
            pass

        async def get_task(self, task_id):
            raise httpx.ConnectError("connection refused")

        async def aclose(self):
            pass

    monkeypatch.setattr(cli, "SafirClient", FakeSafirClient)

    exit_code = await cli._run(_args())

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "error fetching task 42: connection refused" in captured.err


async def test_run_returns_planner_error_when_agent_fails(monkeypatch, capsys):
    _install_fake_env(monkeypatch)

    class FakeSafirClient:
        def __init__(self, *, base_url, api_token):
            pass

        async def get_task(self, task_id):
            return _task()

        async def aclose(self):
            pass

    async def fail_planner(**kwargs):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(cli, "SafirClient", FakeSafirClient)
    monkeypatch.setattr(cli, "run_planner1", fail_planner)

    exit_code = await cli._run(_args())

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "planner1 run failed: model unavailable" in captured.err


async def test_run_returns_submit_error_when_safir_submit_plan_fails(monkeypatch, capsys):
    _install_fake_env(monkeypatch)

    class FakeSafirClient:
        def __init__(self, *, base_url, api_token):
            pass

        async def get_task(self, task_id):
            return _task()

        async def submit_plan(self, parent_task_id, body):
            raise httpx.ConnectError("submit refused")

        async def aclose(self):
            pass

    async def run_planner(**kwargs):
        buffer = StagingBuffer(parent_task_id=42)
        buffer.add_cohort(title="cohort", notes="notes")
        return buffer, "summary"

    monkeypatch.setattr(cli, "SafirClient", FakeSafirClient)
    monkeypatch.setattr(cli, "run_planner1", run_planner)

    exit_code = await cli._run(_args())

    captured = capsys.readouterr()
    assert exit_code == 4
    assert "safir plan submission failed: submit refused" in captured.err


async def test_run_submits_plan_and_prints_plan_id(monkeypatch, capsys):
    _install_fake_env(monkeypatch)
    submitted = {}

    class FakeSafirClient:
        def __init__(self, *, base_url, api_token):
            pass

        async def get_task(self, task_id):
            return _task()

        async def submit_plan(self, parent_task_id, body):
            submitted["parent_task_id"] = parent_task_id
            submitted["body"] = body
            return _plan()

        async def aclose(self):
            pass

    async def run_planner(**kwargs):
        buffer = StagingBuffer(parent_task_id=42)
        buffer.add_cohort(title="cohort", notes="notes")
        return buffer, "summary"

    monkeypatch.setattr(cli, "SafirClient", FakeSafirClient)
    monkeypatch.setattr(cli, "run_planner1", run_planner)

    exit_code = await cli._run(_args())

    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out == "plan_id=plan-1\n"
    assert submitted == {
        "parent_task_id": 42,
        "body": {
            "summary": "summary",
            "model": "model-1",
            "cohorts": [
                {
                    "cohort_index": 0,
                    "title": "cohort",
                    "notes": "notes",
                    "priority": 0,
                }
            ],
            "dependencies": [],
        },
    }
