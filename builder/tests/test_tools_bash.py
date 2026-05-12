"""Tests for BashTool."""
from __future__ import annotations

import json
import time

import pytest

from builder.tools import BashTool, BuildContext


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path, permission_rules={})


@pytest.fixture
def tool(ctx):
    return BashTool(ctx)


@pytest.mark.asyncio
async def test_basic_echo(tmp_path, tool) -> None:
    result = await tool.execute({"command": "echo hello"})
    data = json.loads(result)
    assert data["stdout"] == "hello\n"
    assert data["stderr"] == ""
    assert data["exit_code"] == 0


@pytest.mark.asyncio
async def test_allow_all_overrides_deny(tmp_path) -> None:
    rules = {
        "allow_all": True,
        "deny_patterns": [{"tool": "Bash", "input_match": {"command_prefix": ["echo"]}}],
    }
    ctx = BuildContext(workdir=tmp_path, permission_rules=rules)
    tool = BashTool(ctx)
    result = await tool.execute({"command": "echo allowed"})
    data = json.loads(result)
    assert data["exit_code"] == 0


@pytest.mark.asyncio
async def test_command_prefix_deny(tmp_path) -> None:
    rules = {
        "allow_all": False,
        "deny_patterns": [
            {"tool": "Bash", "input_match": {"command_prefix": ["rm "]}}
        ],
    }
    ctx = BuildContext(workdir=tmp_path, permission_rules=rules)
    tool = BashTool(ctx)
    result = await tool.execute({"command": "rm something"})
    data = json.loads(result)
    assert "error" in data
    assert "denied" in data["error"]


@pytest.mark.asyncio
async def test_input_regex_deny(tmp_path) -> None:
    rules = {
        "allow_all": False,
        "deny_patterns": [
            {"tool": "Bash", "input_match": {"input_regex": r"drop\s+table"}}
        ],
    }
    ctx = BuildContext(workdir=tmp_path, permission_rules=rules)
    tool = BashTool(ctx)
    result = await tool.execute({"command": "echo 'drop table foo'"})
    data = json.loads(result)
    assert "error" in data
    assert "denied" in data["error"]


@pytest.mark.asyncio
async def test_metachar_pipeline_runs(tmp_path, tool) -> None:
    result = await tool.execute({"command": "echo a | cat"})
    data = json.loads(result)
    assert data["stdout"].strip() == "a"


@pytest.mark.asyncio
async def test_no_metachar_uses_shlex(tmp_path, tool) -> None:
    result = await tool.execute({"command": "echo a b"})
    data = json.loads(result)
    assert data["stdout"] == "a b\n"


@pytest.mark.asyncio
async def test_timeout_returns_exit_124(tmp_path, tool) -> None:
    result = await tool.execute({"command": "sleep 10", "timeout_seconds": 1})
    data = json.loads(result)
    assert data["exit_code"] == 124
    assert "[timeout]" in data["stderr"]


@pytest.mark.asyncio
async def test_invalid_timeout_returns_error(tmp_path, tool) -> None:
    for bad in [0, 700]:
        result = await tool.execute({"command": "echo hi", "timeout_seconds": bad})
        data = json.loads(result)
        assert "error" in data


@pytest.mark.asyncio
async def test_command_not_found_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"command": "no_such_command_xyz_42"})
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_pwd_returns_workdir(tmp_path, tool) -> None:
    result = await tool.execute({"command": "pwd"})
    data = json.loads(result)
    assert data["stdout"].strip() == str(tmp_path.resolve())
