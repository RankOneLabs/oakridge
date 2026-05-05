"""Operator-driven memory commit for one agent.

Per the design memo, memory commits are operator-driven for v1: the
operator reviews each agent's project participation and explicitly
approves what generalizes into the agent's persistent memory.
:class:`MemoryCommitter` is the Python API the operator (or a script
driven by the operator) calls to commit approved observations.

No kbbl involvement. Memory commit is internal to legit-biz-club —
kbbl handles tool-call approvals during sessions, not memory commits
at project end. These are different operator surfaces and don't share
machinery.

Persistence is via jig's :class:`SqliteStore`. Each commit writes one
``MemoryEntry`` whose ``content`` is the observation text and whose
``metadata`` carries the design-memo tuple
``(agent_id, project_id, timestamp, tags, operator_confidence,
supersedes?)``. The store's UUID becomes the entry's address — useful
as a ``supersedes`` target for later commits.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from jig.core.types import MemoryEntry
from jig.memory.local import SqliteStore
from pydantic import BaseModel, Field

from legit_biz_club.core.models import Agent


def _utc_now() -> datetime:
    return datetime.now(UTC)


class OperatorConfidence(StrEnum):
    """Coarse ordinal for how confident the operator is in an observation.

    Three levels intentionally — finer gradations would invite spurious
    precision in what's already a subjective call. Cross-project
    aggregation can weight observations by this without inventing new
    metrics.
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class CommitObservation(BaseModel):
    """One operator-approved observation in agent memory.

    Schema per the design memo. ``tags`` are operator-supplied free
    text; ``supersedes`` points at a prior observation's entry_id this
    one replaces — useful when the operator's read of an agent's
    behavior shifts and they want the new observation to override
    rather than accumulate.
    """

    agent_id: str
    project_id: str
    observation_text: str
    operator_confidence: OperatorConfidence
    tags: list[str] = Field(default_factory=list)
    supersedes: str | None = None
    timestamp: datetime = Field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True)
class CommitResult:
    """Return value from :meth:`MemoryCommitter.commit`.

    ``entry_id`` is the SqliteStore-assigned UUID — pass it as
    ``supersedes`` to a later commit if the new observation overrides
    this one.
    """

    entry_id: str
    observation: CommitObservation


# Marker key in metadata so we can distinguish legit-biz-club's
# observation rows from any other content the agent's store might hold
# (jig's SqliteStore is a generic memory backend).
_LBC_METADATA_KIND = "commit_observation"


class MemoryCommitter:
    """Operator-driven memory commit for one agent.

    Caller provides a pre-configured :class:`SqliteStore` (typically
    constructed via ``jig.memory.LocalMemory(db_path=agent.memory_db_path)``)
    bound to the agent's persistent memory file. The committer
    enforces the agent_id <-> store binding by tagging every commit
    with this agent's id; reads filter by it too so a shared store
    won't leak observations across agents.
    """

    def __init__(self, agent: Agent, store: SqliteStore) -> None:
        self.agent = agent
        self._store = store

    async def commit(
        self,
        *,
        project_id: str,
        observation_text: str,
        operator_confidence: OperatorConfidence,
        tags: Sequence[str] = (),
        supersedes: str | None = None,
    ) -> CommitResult:
        """Write an operator-approved observation into the agent's memory.

        Validates non-empty ``project_id`` and ``observation_text``
        because the design memo's schema doesn't admit empty values
        for either — an observation with no text isn't an observation,
        and an unscoped commit can't be filtered by project later.
        """
        if not project_id.strip():
            raise ValueError("project_id must be non-empty")
        if not observation_text.strip():
            raise ValueError("observation_text must be non-empty")
        observation = CommitObservation(
            agent_id=self.agent.id,
            project_id=project_id,
            observation_text=observation_text,
            operator_confidence=operator_confidence,
            tags=list(tags),
            supersedes=supersedes,
        )
        metadata = _serialize_metadata(observation)
        entry_id = await self._store.add(
            observation.observation_text, metadata
        )
        return CommitResult(entry_id=entry_id, observation=observation)

    async def load_observations(
        self,
        *,
        project_id: str | None = None,
    ) -> list[tuple[str, CommitObservation]]:
        """Return committed observations for this agent.

        Filters by ``project_id`` when supplied. Returns
        ``(entry_id, observation)`` tuples — ``entry_id`` matches the
        store-assigned UUID, useful as a ``supersedes`` target for a
        later commit.

        Skips entries whose metadata wasn't written by this module
        (other content the store may hold) and entries belonging to a
        different agent if the store is shared.
        """
        entries = await self._store.all()
        result: list[tuple[str, CommitObservation]] = []
        for entry in entries:
            observation = _deserialize_observation(entry)
            if observation is None:
                continue
            if observation.agent_id != self.agent.id:
                continue
            if project_id is not None and observation.project_id != project_id:
                continue
            result.append((entry.id, observation))
        return result


def _serialize_metadata(observation: CommitObservation) -> dict[str, Any]:
    """Flatten a :class:`CommitObservation` into JSON-safe metadata.

    SqliteStore stores ``metadata`` via ``json.dumps(...)``, so every
    value here must round-trip through JSON. ``observation_text`` is
    NOT in metadata — it's the entry's ``content``, which is what
    embedding-based retrieval indexes against.
    """
    return {
        "lbc_kind": _LBC_METADATA_KIND,
        "agent_id": observation.agent_id,
        "project_id": observation.project_id,
        "timestamp": observation.timestamp.isoformat(),
        "tags": observation.tags,
        "operator_confidence": observation.operator_confidence.value,
        "supersedes": observation.supersedes,
    }


def _deserialize_observation(entry: MemoryEntry) -> CommitObservation | None:
    """Inverse of :func:`_serialize_metadata`. Returns ``None`` for entries
    that aren't legit-biz-club observations or whose metadata is malformed.
    """
    metadata = entry.metadata
    if metadata.get("lbc_kind") != _LBC_METADATA_KIND:
        return None
    try:
        return CommitObservation(
            agent_id=metadata["agent_id"],
            project_id=metadata["project_id"],
            observation_text=entry.content,
            operator_confidence=OperatorConfidence(
                metadata["operator_confidence"]
            ),
            tags=list(metadata.get("tags") or []),
            supersedes=metadata.get("supersedes"),
            timestamp=datetime.fromisoformat(metadata["timestamp"]),
        )
    except (KeyError, ValueError):
        return None
