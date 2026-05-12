"""Tests for GrepTool. Skipped if ripgrep is not installed."""
from __future__ import annotations

import json
import shutil

import pytest

from builder.tools import BuildContext, GrepTool

pytestmark = pytest.mark.skipif(
    shutil.which("rg") is None, reason="ripgrep (rg) not installed"
)


@pytest.fixture
def ctx(tmp_path):
    return BuildContext(workdir=tmp_path)


@pytest.fixture
def tool(ctx):
    return GrepTool(ctx)


@pytest.fixture
def tree(tmp_path):
    py = tmp_path / "src" / "main.py"
    py.parent.mkdir()
    py.write_text("x = 'needle'\n")
    txt = tmp_path / "notes.txt"
    txt.write_text("no match here\n")
    return tmp_path


@pytest.mark.asyncio
async def test_files_with_matches(tree, tool) -> None:
    result = await tool.execute({"pattern": "needle", "output_mode": "files_with_matches"})
    assert "main.py" in result
    assert "notes.txt" not in result


@pytest.mark.asyncio
async def test_content_mode(tree, tool) -> None:
    result = await tool.execute({"pattern": "needle", "output_mode": "content"})
    assert "needle" in result


@pytest.mark.asyncio
async def test_count_mode(tree, tool) -> None:
    result = await tool.execute({"pattern": "needle", "output_mode": "count"})
    assert "1" in result


@pytest.mark.asyncio
async def test_case_insensitive(tree, tool) -> None:
    result = await tool.execute(
        {"pattern": "NEEDLE", "output_mode": "files_with_matches", "case_insensitive": True}
    )
    assert "main.py" in result


@pytest.mark.asyncio
async def test_glob_restricts_to_py(tree, tool) -> None:
    result = await tool.execute(
        {"pattern": "needle", "output_mode": "files_with_matches", "glob": "*.py"}
    )
    assert "main.py" in result


@pytest.mark.asyncio
async def test_no_match_returns_sentinel(tree, tool) -> None:
    result = await tool.execute({"pattern": "nothingmatches12345"})
    assert result == "(no matches)"


@pytest.mark.asyncio
async def test_path_escape_returns_error(tmp_path, tool) -> None:
    result = await tool.execute({"pattern": "x", "path": "../outside"})
    data = json.loads(result)
    assert "error" in data
