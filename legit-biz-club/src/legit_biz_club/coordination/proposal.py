"""Proposal types for the coordination layer.

A :class:`Proposal` is a request from an enrolled agent to mutate the
artifact. The mediator validates it (OCC + project-layer rules) and
either applies, rejects with retry, or rejects terminally. The
:class:`ProposalOutcome` is the mediator's verdict, suitable for both
in-process consumers (the coordinator loop) and broadcast as a workspace
event for the operator surface.
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field


def _new_id() -> str:
    return str(uuid4())


class ProposalResult(StrEnum):
    """Mediator's verdict on a proposal."""

    APPLIED = "applied"
    REJECTED_OCC = "rejected_occ"
    REJECTED_VALIDATION = "rejected_validation"
    BUDGET_EXHAUSTED = "budget_exhausted"


class Proposal(BaseModel):
    """A change proposed by an enrolled agent.

    Carries an OCC token (``based_on_version``) so the mediator can
    detect state drift between an agent's read and its write.
    ``new_content`` is the full proposed next-state of the artifact for
    v1 — we accept the simplicity tax (compared to diffs) in exchange
    for trivially auditable behavior.
    """

    id: str = Field(default_factory=_new_id)
    agent_id: str
    based_on_version: str
    new_content: str
    rationale: str = ""
    proposed_at: datetime = Field(default_factory=datetime.now)


class ProposalOutcome(BaseModel):
    """The mediator's response to a single :class:`Proposal`.

    ``new_version`` is the artifact's version after a successful apply
    and ``None`` for any rejection. ``reason`` is human-readable and
    surfaces to the operator UI; ``None`` for applies.
    """

    proposal: Proposal
    result: ProposalResult
    new_version: str | None = None
    reason: str | None = None
    decided_at: datetime = Field(default_factory=datetime.now)
