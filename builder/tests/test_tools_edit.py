"""Tests for EditTool."""
from __future__ import annotations

import json

import pytest

from builder.tools import BuildContext, EditTool


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path)


@pytest.fixture
def tool(ctx):
    return EditTool(ctx)


@pytest.mark.asyncio
async def test_single_match_edit(tmp_path, tool) -> None:
    f = tmp_path / "f.txt"
    f.write_text("hello world")
    result = await tool.execute({"path": "f.txt", "old_string": "world", "new_string": "claude"})
    data = json.loads(result)
    assert data["replacements"] == 1
    assert f.read_text() == "hello claude"


@pytest.mark.asyncio
async def test_multi_match_without_replace_all_returns_error(tmp_path, tool) -> None:
    f = tmp_path / "f.txt"
    f.write_text("x x x")
    result = await tool.execute({"path": "f.txt", "old_string": "x", "new_string": "y"})
    data = json.loads(result)
    assert "error" in data
    assert "3 times" in data["error"]


@pytest.mark.asyncio
async def test_multi_match_with_replace_all(tmp_path, tool) -> None:
    f = tmp_path / "f.txt"
    f.write_text("x x x")
    result = await tool.execute(
        {"path": "f.txt", "old_string": "x", "new_string": "y", "replace_all": True}
    )
    data = json.loads(result)
    assert data["replacements"] == 3
    assert f.read_text() == "y y y"


@pytest.mark.asyncio
async def test_old_string_not_found_returns_error(tmp_path, tool) -> None:
    f = tmp_path / "f.txt"
    f.write_text("hello")
    result = await tool.execute({"path": "f.txt", "old_string": "xyz", "new_string": "abc"})
    data = json.loads(result)
    assert "error" in data
    assert "not found" in data["error"]


@pytest.mark.asyncio
async def test_empty_old_string_returns_error(tmp_path, tool) -> None:
    f = tmp_path / "f.txt"
    f.write_text("hello")
    result = await tool.execute({"path": "f.txt", "old_string": "", "new_string": "x"})
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_missing_file_returns_error(tmp_path, tool) -> None:
    result = await tool.execute(
        {"path": "missing.txt", "old_string": "a", "new_string": "b"}
    )
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_path_escape_returns_error(tmp_path, tool) -> None:
    result = await tool.execute(
        {"path": "../outside.txt", "old_string": "a", "new_string": "b"}
    )
    data = json.loads(result)
    assert "error" in data
