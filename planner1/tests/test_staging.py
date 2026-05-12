import pytest

from planner1.staging import CycleError, StagingBuffer


def test_empty_buffer_toposort_is_empty():
    b = StagingBuffer(parent_task_id=1)
    assert b.toposort() == []


def test_add_task_assigns_zero_based_index():
    b = StagingBuffer(parent_task_id=1)
    t0 = b.add_task(title="t0", notes="n0")
    t1 = b.add_task(title="t1", notes="n1")
    assert t0.index == 0
    assert t1.index == 1


def test_self_dependency_rejected():
    b = StagingBuffer(parent_task_id=1)
    b.add_task(title="t0", notes="n0")
    with pytest.raises(CycleError):
        b.add_dependency(task_index=0, depends_on_index=0)


def test_out_of_range_dependency_raises_index_error():
    b = StagingBuffer(parent_task_id=1)
    b.add_task(title="t0", notes="n0")
    with pytest.raises(IndexError):
        b.add_dependency(task_index=0, depends_on_index=5)


def test_simple_dependency_orders_correctly():
    b = StagingBuffer(parent_task_id=1)
    b.add_task(title="t0", notes="n0")
    b.add_task(title="t1", notes="n1")
    b.add_dependency(task_index=1, depends_on_index=0)
    assert b.toposort() == [0, 1]


def test_transitive_cycle_rejected_and_buffer_unchanged():
    b = StagingBuffer(parent_task_id=1)
    b.add_task(title="t0", notes="n0")
    b.add_task(title="t1", notes="n1")
    b.add_task(title="t2", notes="n2")
    b.add_dependency(task_index=1, depends_on_index=0)
    b.add_dependency(task_index=2, depends_on_index=1)
    with pytest.raises(CycleError):
        b.add_dependency(task_index=0, depends_on_index=2)
    assert len(b.dependencies) == 2


def test_to_payload_shape():
    b = StagingBuffer(parent_task_id=42)
    b.add_task(title="t0", notes="n0")
    b.add_task(title="t1", notes="n1", priority=5)
    b.add_dependency(task_index=1, depends_on_index=0)
    p = b.to_payload(summary="all done", model="claude-opus-4-7")
    assert p["parent_task_id"] == 42
    assert len(p["tasks"]) == 2
    assert p["tasks"][1]["priority"] == 5
    assert p["dependencies"] == [{"task_index": 1, "depends_on_index": 0}]
    assert p["summary"] == "all done"
    assert p["model"] == "claude-opus-4-7"
    assert "created_at" in p
