"""Tests for WriteTool."""
from __future__ import annotations

import json

import pytest

from builder.tools import BuildContext, WriteTool


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path)


@pytest.fixture
def tool(ctx):
    return WriteTool(ctx)


@pytest.mark.asyncio
async def test_write_new_file(tmp_path, tool) -> None:
    result = await tool.execute({"path": "new.txt", "content": "hello"})
    data = json.loads(result)
    assert data["path"].endswith("new.txt")
    assert data["bytes_written"] == 5
    assert (tmp_path / "new.txt").read_text() == "hello"


@pytest.mark.asyncio
async def test_write_overwrites_existing(tmp_path, tool) -> None:
    (tmp_path / "over.txt").write_text("old")
    await tool.execute({"path": "over.txt", "content": "new"})
    assert (tmp_path / "over.txt").read_text() == "new"


@pytest.mark.asyncio
async def test_write_creates_parent_dirs(tmp_path, tool) -> None:
    result = await tool.execute({"path": "a/b/c.txt", "content": "deep"})
    data = json.loads(result)
    assert "error" not in data
    assert (tmp_path / "a" / "b" / "c.txt").read_text() == "deep"


@pytest.mark.asyncio
async def test_write_outside_workdir_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"path": "../outside.txt", "content": "x"})
    data = json.loads(result)
    assert "error" in data
