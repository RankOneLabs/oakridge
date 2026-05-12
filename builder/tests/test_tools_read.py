"""Tests for ReadTool."""
from __future__ import annotations

import json

import pytest

from builder.tools import BuildContext, ReadTool


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path)


@pytest.fixture
def tool(ctx):
    return ReadTool(ctx)


@pytest.mark.asyncio
async def test_read_existing_file(tmp_path, tool) -> None:
    f = tmp_path / "hello.txt"
    f.write_text("hello world", encoding="utf-8")
    result = await tool.execute({"path": "hello.txt"})
    assert result == "hello world"


@pytest.mark.asyncio
async def test_read_numbered(tmp_path, tool) -> None:
    f = tmp_path / "lines.txt"
    f.write_text("a\nb\nc", encoding="utf-8")
    result = await tool.execute({"path": "lines.txt", "numbered": True})
    lines = result.splitlines()
    assert lines[0] == "1\ta"
    assert lines[1] == "2\tb"
    assert lines[2] == "3\tc"


@pytest.mark.asyncio
async def test_read_missing_file_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"path": "nonexistent.txt"})
    data = json.loads(result)
    assert "error" in data
    assert "not found" in data["error"]


@pytest.mark.asyncio
async def test_read_escape_workdir_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"path": "../escape.txt"})
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_read_directory_returns_error(tmp_path, tool) -> None:
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    result = await tool.execute({"path": "subdir"})
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_read_absolute_path_inside_workdir(tmp_path, tool) -> None:
    f = tmp_path / "abs.txt"
    f.write_text("absolute", encoding="utf-8")
    result = await tool.execute({"path": str(f)})
    assert result == "absolute"
