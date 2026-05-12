"""Tests for GlobTool."""
from __future__ import annotations

import json
import os
import time

import pytest

from builder.tools import BuildContext, GlobTool


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path)


@pytest.fixture
def tool(ctx):
    return GlobTool(ctx)


@pytest.mark.asyncio
async def test_finds_txt_files(tmp_path, tool) -> None:
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.txt").write_text("b")
    (tmp_path / "c.py").write_text("c")
    result = await tool.execute({"pattern": "**/*.txt"})
    assert "a.txt" in result
    assert "b.txt" in result
    assert "c.py" not in result


@pytest.mark.asyncio
async def test_no_match_returns_sentinel(tmp_path, tool) -> None:
    result = await tool.execute({"pattern": "**/*.does-not-exist"})
    assert result == "(no matches)"


@pytest.mark.asyncio
async def test_path_escape_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"pattern": "*.txt", "path": "../outside"})
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_mtime_sorted_descending(tmp_path, tool) -> None:
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    c = tmp_path / "c.txt"
    a.write_text("a")
    b.write_text("b")
    c.write_text("c")
    now = time.time()
    os.utime(a, (now - 20, now - 20))
    os.utime(b, (now - 10, now - 10))
    os.utime(c, (now, now))
    result = await tool.execute({"pattern": "*.txt"})
    lines = result.splitlines()
    assert lines[0] == "c.txt"


@pytest.mark.asyncio
async def test_capped_at_250_entries(tmp_path, tool) -> None:
    for i in range(300):
        (tmp_path / f"f{i}.txt").write_text(str(i))
    result = await tool.execute({"pattern": "*.txt"})
    assert len(result.splitlines()) == 250
