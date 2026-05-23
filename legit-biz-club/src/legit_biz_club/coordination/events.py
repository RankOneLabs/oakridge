"""Workspace event types emitted by coordination flows."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Literal, TypedDict

WorkspaceEventKind = Literal[
    "incremental_started",
    "incremental_terminated",
    "proposal_applied",
    "proposal_rejected_occ",
    "proposal_rejected_validation",
    "agent_budget_exhausted",
    "convergence_started",
    "round_completed",
    "escalation_triggered",
    "proposal_picked",
]

type WorkspaceEventPayload = Mapping[str, object]
type WorkspaceEventEmitter = Callable[[WorkspaceEventKind, WorkspaceEventPayload], Awaitable[None]]


class IncrementalStartedPayload(TypedDict):
    agent_ids: list[str]
    retry_budget: int


class IncrementalTerminatedPayload(TypedDict):
    terminated_by: str
    commit_counts: dict[str, int]


class ProposalOutcomePayload(TypedDict):
    agent_id: str
    proposal_id: str
    reason: str | None
    new_version: str | None


class ConvergenceStartedPayload(TypedDict):
    mechanism: str
    agent_ids: list[str]


class RoundCompletedPayload(TypedDict):
    round_index: int
    converged: bool
    n_proposals: int


class EscalationTriggeredPayload(TypedDict):
    round_index: int
    n_residual_proposals: int


class ProposalPickedPayload(TypedDict):
    agent_id: str
    proposal_id: str
    rationale: str
    converged_at_round: int | None
