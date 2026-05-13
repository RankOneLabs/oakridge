import pytest

from planner1.staging import CycleError, StagingBuffer


def test_empty_buffer_toposort_is_empty():
    b = StagingBuffer(parent_task_id=1)
    assert b.toposort() == []


def test_add_cohort_assigns_zero_based_index():
    b = StagingBuffer(parent_task_id=1)
    c0 = b.add_cohort(title="c0", notes="n0")
    c1 = b.add_cohort(title="c1", notes="n1")
    assert c0.cohort_index == 0
    assert c1.cohort_index == 1


def test_self_dependency_rejected():
    b = StagingBuffer(parent_task_id=1)
    b.add_cohort(title="c0", notes="n0")
    with pytest.raises(CycleError):
        b.add_cohort_dependency(cohort_index=0, depends_on_cohort_index=0)


def test_out_of_range_dependency_raises_index_error():
    b = StagingBuffer(parent_task_id=1)
    b.add_cohort(title="c0", notes="n0")
    with pytest.raises(IndexError):
        b.add_cohort_dependency(cohort_index=0, depends_on_cohort_index=5)


def test_simple_dependency_orders_correctly():
    b = StagingBuffer(parent_task_id=1)
    b.add_cohort(title="c0", notes="n0")
    b.add_cohort(title="c1", notes="n1")
    b.add_cohort_dependency(cohort_index=1, depends_on_cohort_index=0)
    assert b.toposort() == [0, 1]


def test_transitive_cycle_rejected_and_buffer_unchanged():
    b = StagingBuffer(parent_task_id=1)
    b.add_cohort(title="c0", notes="n0")
    b.add_cohort(title="c1", notes="n1")
    b.add_cohort(title="c2", notes="n2")
    b.add_cohort_dependency(cohort_index=1, depends_on_cohort_index=0)
    b.add_cohort_dependency(cohort_index=2, depends_on_cohort_index=1)
    with pytest.raises(CycleError):
        b.add_cohort_dependency(cohort_index=0, depends_on_cohort_index=2)
    assert len(b.dependencies) == 2


def test_to_payload_shape():
    b = StagingBuffer(parent_task_id=42)
    b.add_cohort(title="c0", notes="n0")
    b.add_cohort(title="c1", notes="n1", priority=5)
    b.add_cohort_dependency(cohort_index=1, depends_on_cohort_index=0)
    p = b.to_payload(summary="all done", model="claude-opus-4-7")
    assert len(p["cohorts"]) == 2
    assert p["cohorts"][1]["priority"] == 5
    assert p["cohorts"][0]["cohort_index"] == 0
    assert p["dependencies"] == [{"cohort_index": 1, "depends_on_cohort_index": 0}]
    assert p["summary"] == "all done"
    assert p["model"] == "claude-opus-4-7"
