import json

import pytest

from planner1.staging import StagingBuffer
from planner1.tools import AddDependencyTool, CreateTaskTool


@pytest.mark.asyncio
async def test_create_task_tool_appends_to_buffer():
    b = StagingBuffer(parent_task_id=1)
    tool = CreateTaskTool(b)
    out = await tool.execute({"title": "foo", "notes": "bar"})
    parsed = json.loads(out)
    assert parsed == {"staged_task_index": 0, "title": "foo"}
    assert b.tasks[0].notes == "bar"


@pytest.mark.asyncio
async def test_create_task_tool_default_priority_zero():
    b = StagingBuffer(parent_task_id=1)
    await CreateTaskTool(b).execute({"title": "foo", "notes": "bar"})
    assert b.tasks[0].priority == 0


@pytest.mark.asyncio
async def test_add_dependency_tool_records_edge():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateTaskTool(b)
    await ct.execute({"title": "a", "notes": "."})
    await ct.execute({"title": "b", "notes": "."})
    out = await AddDependencyTool(b).execute({"task_index": 1, "depends_on_index": 0})
    assert json.loads(out) == {"task_index": 1, "depends_on_index": 0}
    assert len(b.dependencies) == 1


@pytest.mark.asyncio
async def test_add_dependency_tool_returns_error_string_on_cycle():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateTaskTool(b)
    await ct.execute({"title": "a", "notes": "."})
    out = await AddDependencyTool(b).execute({"task_index": 0, "depends_on_index": 0})
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.dependencies) == 0


def test_tool_definition_create_task_shape():
    d = CreateTaskTool(StagingBuffer(parent_task_id=1)).definition
    assert d.name == "create_task"
    assert d.parameters["required"] == ["title", "notes"]
    assert "priority" in d.parameters["properties"]


def test_tool_definition_add_dependency_shape():
    d = AddDependencyTool(StagingBuffer(parent_task_id=1)).definition
    assert d.name == "add_dependency"
    assert d.parameters["required"] == ["task_index", "depends_on_index"]


@pytest.mark.asyncio
async def test_create_task_tool_returns_error_on_missing_key():
    b = StagingBuffer(parent_task_id=1)
    out = await CreateTaskTool(b).execute({"title": "foo"})  # missing notes
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.tasks) == 0


@pytest.mark.asyncio
async def test_add_dependency_tool_returns_error_on_non_integer_index():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateTaskTool(b)
    await ct.execute({"title": "a", "notes": "."})
    out = await AddDependencyTool(b).execute({"task_index": "x", "depends_on_index": 0})
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.dependencies) == 0
