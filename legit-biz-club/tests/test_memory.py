"""Tests for :class:`MemoryCommitter`.

Cover commit + load round-trip, project_id filtering, supersedes
pointer, agent isolation across a shared store, and the input
validation paths.

Uses a stub embedder so SqliteStore.add() doesn't try to reach a real
ollama server. The embedder is required by jig's SqliteStore but the
specific vector content doesn't matter for memory-commit correctness
— retrieval-based queries are a v1.x concern.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from jig.memory.local import SqliteStore

from legit_biz_club import Agent
from legit_biz_club.core.models import Artifact, ArtifactType, Brief, Project
from legit_biz_club.memory import (
    CommitObservation,
    CommitResult,
    MemoryCommitter,
    OperatorConfidence,
    make_sqlite_observation_loader,
)


async def _stub_embed(_text: str) -> np.ndarray:
    """Returns a fixed 8-dim zero vector. SqliteStore requires an
    embedder to run add(), but commit-correctness is independent of
    vector content."""
    return np.zeros(8, dtype=np.float32)


def _agent(tmp_path: Path, name: str = "alice") -> Agent:
    return Agent(
        name=name,
        model="claude-sonnet-4-5",
        system_prompt="be careful",
        memory_db_path=tmp_path / f"{name}.db",
    )


def _store(tmp_path: Path, name: str = "alice") -> SqliteStore:
    return SqliteStore(
        db_path=str(tmp_path / f"{name}.db"),
        embedder=_stub_embed,
    )


# --- happy path ----------------------------------------------------------


async def test_commit_returns_entry_id_and_observation(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    committer = MemoryCommitter(agent, _store(tmp_path))
    result = await committer.commit(
        project_id="p-1",
        observation_text="agent prefers concise prose",
        operator_confidence=OperatorConfidence.HIGH,
        tags=["style"],
    )
    assert isinstance(result, CommitResult)
    assert result.entry_id  # uuid string
    assert isinstance(result.observation, CommitObservation)
    assert result.observation.agent_id == agent.id
    assert result.observation.project_id == "p-1"
    assert result.observation.observation_text == "agent prefers concise prose"
    assert result.observation.operator_confidence == OperatorConfidence.HIGH
    assert result.observation.tags == ["style"]
    assert result.observation.supersedes is None
    # Timestamp is UTC-aware.
    assert result.observation.timestamp.tzinfo is not None


async def test_load_observations_returns_what_was_committed(
    tmp_path: Path,
) -> None:
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    r1 = await committer.commit(
        project_id="p-1",
        observation_text="first observation",
        operator_confidence=OperatorConfidence.MEDIUM,
        tags=["a"],
    )
    r2 = await committer.commit(
        project_id="p-1",
        observation_text="second observation",
        operator_confidence=OperatorConfidence.LOW,
        tags=["b", "c"],
    )
    loaded = await committer.load_observations()
    assert len(loaded) == 2
    by_id = {entry_id: obs for entry_id, obs in loaded}
    assert r1.entry_id in by_id
    assert r2.entry_id in by_id
    assert by_id[r1.entry_id].observation_text == "first observation"
    assert by_id[r2.entry_id].observation_text == "second observation"
    assert by_id[r2.entry_id].tags == ["b", "c"]


# --- project filtering --------------------------------------------------


async def test_load_observations_filters_by_project(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    committer = MemoryCommitter(agent, _store(tmp_path))
    await committer.commit(
        project_id="p-1",
        observation_text="from project 1",
        operator_confidence=OperatorConfidence.HIGH,
    )
    await committer.commit(
        project_id="p-2",
        observation_text="from project 2",
        operator_confidence=OperatorConfidence.HIGH,
    )
    p1_only = await committer.load_observations(project_id="p-1")
    assert len(p1_only) == 1
    assert p1_only[0][1].project_id == "p-1"
    p2_only = await committer.load_observations(project_id="p-2")
    assert len(p2_only) == 1
    assert p2_only[0][1].project_id == "p-2"


# --- supersedes pointer --------------------------------------------------


async def test_supersedes_pointer_round_trips(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    committer = MemoryCommitter(agent, _store(tmp_path))
    earlier = await committer.commit(
        project_id="p-1",
        observation_text="initial read",
        operator_confidence=OperatorConfidence.MEDIUM,
    )
    revised = await committer.commit(
        project_id="p-2",
        observation_text="revised read",
        operator_confidence=OperatorConfidence.HIGH,
        supersedes=earlier.entry_id,
    )
    assert revised.observation.supersedes == earlier.entry_id

    loaded = await committer.load_observations()
    matching = [
        obs
        for _, obs in loaded
        if obs.observation_text == "revised read"
    ]
    assert len(matching) == 1
    assert matching[0].supersedes == earlier.entry_id


# --- agent isolation -----------------------------------------------------


async def test_load_filters_to_this_agents_observations(
    tmp_path: Path,
) -> None:
    """Two agents sharing a SqliteStore (unusual but possible) should
    each see only their own observations on load."""
    alice = _agent(tmp_path, name="alice")
    bob = _agent(tmp_path, name="bob")
    shared_store = _store(tmp_path, name="shared")
    alice_committer = MemoryCommitter(alice, shared_store)
    bob_committer = MemoryCommitter(bob, shared_store)
    await alice_committer.commit(
        project_id="p-1",
        observation_text="alice's obs",
        operator_confidence=OperatorConfidence.HIGH,
    )
    await bob_committer.commit(
        project_id="p-1",
        observation_text="bob's obs",
        operator_confidence=OperatorConfidence.HIGH,
    )
    alice_loaded = await alice_committer.load_observations()
    bob_loaded = await bob_committer.load_observations()
    assert len(alice_loaded) == 1
    assert alice_loaded[0][1].observation_text == "alice's obs"
    assert len(bob_loaded) == 1
    assert bob_loaded[0][1].observation_text == "bob's obs"


# --- non-lbc entries are skipped ----------------------------------------


async def test_load_skips_malformed_lbc_entries(tmp_path: Path) -> None:
    """A row tagged as an lbc observation but with malformed metadata
    (e.g., non-string timestamp, missing required field) is skipped
    rather than crashing load_observations()."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    # Write a malformed lbc entry — has the marker key but a
    # non-string timestamp (would TypeError out of fromisoformat).
    await store.add(
        "malformed observation",
        {
            "lbc_kind": "commit_observation",
            "agent_id": agent.id,
            "project_id": "p-1",
            "timestamp": 12345,  # int, not string — TypeError
            "tags": [],
            "operator_confidence": "high",
            "supersedes": None,
        },
    )
    committer = MemoryCommitter(agent, store)
    await committer.commit(
        project_id="p-1",
        observation_text="real observation",
        operator_confidence=OperatorConfidence.HIGH,
    )
    # Malformed row dropped; real one survives.
    loaded = await committer.load_observations()
    assert len(loaded) == 1
    assert loaded[0][1].observation_text == "real observation"


async def test_load_skips_non_lbc_entries(tmp_path: Path) -> None:
    """A SqliteStore shared with non-legit-biz-club code (e.g., jig
    agent memory written by a different consumer) shouldn't have its
    entries surface as fake observations."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    # Write a non-lbc entry directly.
    await store.add(
        "some other content",
        {"source": "elsewhere", "purpose": "not an observation"},
    )
    committer = MemoryCommitter(agent, store)
    await committer.commit(
        project_id="p-1",
        observation_text="real observation",
        operator_confidence=OperatorConfidence.HIGH,
    )
    loaded = await committer.load_observations()
    assert len(loaded) == 1
    assert loaded[0][1].observation_text == "real observation"


# --- input validation ---------------------------------------------------


async def test_rejects_empty_project_id(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    committer = MemoryCommitter(agent, _store(tmp_path))
    with pytest.raises(ValueError, match="project_id"):
        await committer.commit(
            project_id="",
            observation_text="x",
            operator_confidence=OperatorConfidence.HIGH,
        )


async def test_rejects_empty_observation_text(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    committer = MemoryCommitter(agent, _store(tmp_path))
    with pytest.raises(ValueError, match="observation_text"):
        await committer.commit(
            project_id="p-1",
            observation_text="   ",  # whitespace-only counts as empty
            operator_confidence=OperatorConfidence.HIGH,
        )


# --- make_sqlite_observation_loader -------------------------------------


def _stub_project(project_id: str = "p-current") -> Project:
    """Minimal Project with the right id — the loader only reads .id."""
    return Project(
        id=project_id,
        artifact=Artifact(type=ArtifactType.PROSE, path=Path("/tmp/x.md")),
        brief=Brief(target_spec="x", success_criteria=["x"]),
    )


async def test_loader_returns_empty_when_no_observations(
    tmp_path: Path,
) -> None:
    """Empty store → empty string. JigProposer's empty-context branch
    keeps the prompt unchanged in this case."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    loader = make_sqlite_observation_loader(store)
    result = await loader(agent, _stub_project())
    assert result == ""


async def test_loader_formats_observations_as_bullets(
    tmp_path: Path,
) -> None:
    """The loader returns the agent's observations as a markdown
    bullet list with confidence + tags inline. Format is stable so
    operators can rely on it for prompt-template tweaking."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    await committer.commit(
        project_id="p-1",
        observation_text="prefers concise prose",
        operator_confidence=OperatorConfidence.HIGH,
        tags=["style"],
    )
    await committer.commit(
        project_id="p-2",
        observation_text="over-explains technical sections",
        operator_confidence=OperatorConfidence.MEDIUM,
        tags=["pattern", "writing"],
    )
    loader = make_sqlite_observation_loader(store)
    result = await loader(agent, _stub_project())
    assert "From your prior project work:" in result
    assert "(high) [style] prefers concise prose" in result
    assert "(medium) [pattern, writing] over-explains" in result


async def test_loader_excludes_current_project_by_default(
    tmp_path: Path,
) -> None:
    """Observations committed under the current project_id are dropped
    by default — those were committed by an earlier run of the same
    project and aren't 'what you bring from elsewhere.'"""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    await committer.commit(
        project_id="p-current",
        observation_text="should be excluded",
        operator_confidence=OperatorConfidence.HIGH,
    )
    await committer.commit(
        project_id="p-other",
        observation_text="should appear",
        operator_confidence=OperatorConfidence.HIGH,
    )
    loader = make_sqlite_observation_loader(store)  # default: exclude
    result = await loader(agent, _stub_project("p-current"))
    assert "should appear" in result
    assert "should be excluded" not in result


async def test_loader_includes_current_project_when_opted_in(
    tmp_path: Path,
) -> None:
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    await committer.commit(
        project_id="p-current",
        observation_text="from same project",
        operator_confidence=OperatorConfidence.HIGH,
    )
    loader = make_sqlite_observation_loader(
        store, exclude_current_project=False
    )
    result = await loader(agent, _stub_project("p-current"))
    assert "from same project" in result


async def test_loader_drops_superseded_observations(
    tmp_path: Path,
) -> None:
    """The design memo's supersedes contract is 'override rather than
    accumulate' — when a revised observation points at an earlier
    entry_id, the original should NOT surface alongside it. Otherwise
    the prompt shows both the stale read and its replacement."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    earlier = await committer.commit(
        project_id="p-1",
        observation_text="initial (stale) read",
        operator_confidence=OperatorConfidence.MEDIUM,
    )
    await committer.commit(
        project_id="p-2",
        observation_text="revised read — this one wins",
        operator_confidence=OperatorConfidence.HIGH,
        supersedes=earlier.entry_id,
    )
    loader = make_sqlite_observation_loader(store)
    result = await loader(agent, _stub_project("p-other"))
    assert "revised read" in result
    assert "initial (stale)" not in result


async def test_loader_supersedes_applied_before_current_project_filter(
    tmp_path: Path,
) -> None:
    """When the superseding observation lives in the current project,
    it gets dropped by exclude_current_project — but its supersedes
    pointer must still suppress the older entry it replaces.
    Otherwise a stale observation from a prior project resurfaces
    because the signal that retired it was filtered out first."""
    agent = _agent(tmp_path)
    store = _store(tmp_path)
    committer = MemoryCommitter(agent, store)
    # The stale read lives in a prior project — survives the
    # current-project filter on its own.
    earlier = await committer.commit(
        project_id="p-prior",
        observation_text="initial (stale) read",
        operator_confidence=OperatorConfidence.MEDIUM,
    )
    # The revision lives in the CURRENT project — the operator
    # committed it during an earlier run of the same project. It
    # should be filtered out (as "earlier work in this project") but
    # its supersedes pointer must still take effect.
    await committer.commit(
        project_id="p-current",
        observation_text="revised read — committed during current project",
        operator_confidence=OperatorConfidence.HIGH,
        supersedes=earlier.entry_id,
    )
    loader = make_sqlite_observation_loader(store)  # default: exclude
    result = await loader(agent, _stub_project("p-current"))
    # Stale observation must be dropped by the supersedes signal even
    # though its superseder got filtered out as current-project work.
    assert "initial (stale)" not in result
    # Current-project superseder is still excluded from the bullets.
    assert "revised read" not in result
    # And with no observations left, the loader returns "".
    assert result == ""


async def test_loader_filters_to_this_agents_observations(
    tmp_path: Path,
) -> None:
    """A shared store with two agents' observations: each agent's
    loader only surfaces its own. Same isolation guarantee as
    MemoryCommitter.load_observations() — the loader inherits it."""
    alice = _agent(tmp_path, name="alice")
    bob = _agent(tmp_path, name="bob")
    shared_store = _store(tmp_path, name="shared")
    await MemoryCommitter(alice, shared_store).commit(
        project_id="p-1",
        observation_text="alice's read",
        operator_confidence=OperatorConfidence.HIGH,
    )
    await MemoryCommitter(bob, shared_store).commit(
        project_id="p-1",
        observation_text="bob's read",
        operator_confidence=OperatorConfidence.HIGH,
    )
    loader = make_sqlite_observation_loader(shared_store)
    alice_ctx = await loader(alice, _stub_project())
    bob_ctx = await loader(bob, _stub_project())
    assert "alice's read" in alice_ctx
    assert "bob's read" not in alice_ctx
    assert "bob's read" in bob_ctx
    assert "alice's read" not in bob_ctx
