import json

import pytest

from planner1.staging import StagingBuffer
from planner1.tools import AddCohortDependencyTool, CreateCohortTool


@pytest.mark.asyncio
async def test_create_cohort_tool_appends_to_buffer():
    b = StagingBuffer(parent_task_id=1)
    tool = CreateCohortTool(b)
    out = await tool.execute({"title": "foo", "notes": "bar"})
    parsed = json.loads(out)
    assert parsed == {"cohort_index": 0, "title": "foo"}
    assert b.cohorts[0].notes == "bar"


@pytest.mark.asyncio
async def test_create_cohort_tool_default_priority_zero():
    b = StagingBuffer(parent_task_id=1)
    await CreateCohortTool(b).execute({"title": "foo", "notes": "bar"})
    assert b.cohorts[0].priority == 0


@pytest.mark.asyncio
async def test_add_cohort_dependency_tool_records_edge():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateCohortTool(b)
    await ct.execute({"title": "a", "notes": "."})
    await ct.execute({"title": "b", "notes": "."})
    out = await AddCohortDependencyTool(b).execute(
        {"cohort_index": 1, "depends_on_cohort_index": 0}
    )
    assert json.loads(out) == {"cohort_index": 1, "depends_on_cohort_index": 0}
    assert len(b.dependencies) == 1


@pytest.mark.asyncio
async def test_add_cohort_dependency_tool_returns_error_string_on_cycle():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateCohortTool(b)
    await ct.execute({"title": "a", "notes": "."})
    out = await AddCohortDependencyTool(b).execute(
        {"cohort_index": 0, "depends_on_cohort_index": 0}
    )
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.dependencies) == 0


def test_tool_definition_create_cohort_shape():
    d = CreateCohortTool(StagingBuffer(parent_task_id=1)).definition
    assert d.name == "create_cohort"
    assert d.parameters["required"] == ["title", "notes"]
    assert "priority" in d.parameters["properties"]


def test_tool_definition_add_cohort_dependency_shape():
    d = AddCohortDependencyTool(StagingBuffer(parent_task_id=1)).definition
    assert d.name == "add_cohort_dependency"
    assert d.parameters["required"] == ["cohort_index", "depends_on_cohort_index"]


@pytest.mark.asyncio
async def test_create_cohort_tool_returns_error_on_missing_key():
    b = StagingBuffer(parent_task_id=1)
    out = await CreateCohortTool(b).execute({"title": "foo"})  # missing notes
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.cohorts) == 0


@pytest.mark.asyncio
async def test_add_cohort_dependency_tool_returns_error_on_non_integer_index():
    b = StagingBuffer(parent_task_id=1)
    ct = CreateCohortTool(b)
    await ct.execute({"title": "a", "notes": "."})
    out = await AddCohortDependencyTool(b).execute(
        {"cohort_index": "x", "depends_on_cohort_index": 0}
    )
    parsed = json.loads(out)
    assert "error" in parsed
    assert len(b.dependencies) == 0
