"""Composition policy and heterogeneity checks for ensemble enrollment.

The design supports homogeneous, heterogeneous-along-axes, and mixed
configurations. Heterogeneity checks enforce uniqueness on selected axes
for n>=3; n<3 silently skips. This module supplies the policy data model
and the check function called at enrollment time.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from enum import StrEnum

from pydantic import BaseModel, Field

from legit_biz_club.core.models import Agent, Enrollment


class CompositionMode(StrEnum):
    HOMOGENEOUS = "homogeneous"
    HETEROGENEOUS = "heterogeneous"
    MIXED = "mixed"


class HeterogeneityAxis(StrEnum):
    """The three axes v1 supports.

    ``MODEL_IDENTITY`` is mechanically enforced (no two agents share a
    model). ``SYSTEM_PROMPT_FRAME`` is honor-system in v1 — distinct
    text, no similarity check. ``BINDING`` is enforced via
    :class:`Enrollment.binding` uniqueness when enabled.
    """

    MODEL_IDENTITY = "model_identity"
    SYSTEM_PROMPT_FRAME = "system_prompt_frame"
    BINDING = "binding"


class CompositionPolicy(BaseModel):
    """Per-project composition configuration.

    Heterogeneity check applies for n>=3 with default-on; n=1 and n=2
    silently skip. Composition policy is overridable in all cases via
    ``enforced_axes`` — pass an empty list to disable mechanical checks
    even when n>=3.
    """

    mode: CompositionMode = CompositionMode.HETEROGENEOUS
    enforced_axes: list[HeterogeneityAxis] = Field(
        default_factory=lambda: [
            HeterogeneityAxis.MODEL_IDENTITY,
            HeterogeneityAxis.SYSTEM_PROMPT_FRAME,
        ]
    )


class HeterogeneityViolation(BaseModel):
    """A specific axis on which uniqueness was violated."""

    axis: HeterogeneityAxis
    duplicate_value: str
    affected_agent_ids: list[str]


class HeterogeneityCheckFailed(ValueError):
    """Raised when a heterogeneous composition policy would be violated."""

    def __init__(self, violations: list[HeterogeneityViolation]):
        self.violations = violations
        super().__init__(
            f"heterogeneity check failed on {len(violations)} axis/axes"
        )


_MIN_AGENTS_FOR_CHECK = 3


def check_heterogeneity(
    agents: Sequence[Agent],
    enrollments: Sequence[Enrollment],
    policy: CompositionPolicy,
) -> list[HeterogeneityViolation]:
    """Return heterogeneity violations for the given ensemble.

    Empty list when the configuration is valid. n<3 returns empty list
    without inspection (silent skip per design). ``HOMOGENEOUS`` policies
    return empty list (no axes to enforce). ``MIXED`` and ``HETEROGENEOUS``
    enforce only the explicitly listed ``policy.enforced_axes``.
    """
    if len(agents) < _MIN_AGENTS_FOR_CHECK:
        return []
    if policy.mode == CompositionMode.HOMOGENEOUS:
        return []

    violations: list[HeterogeneityViolation] = []
    agent_ids = {a.id for a in agents}

    for axis in policy.enforced_axes:
        if axis == HeterogeneityAxis.MODEL_IDENTITY:
            violations.extend(
                _agents_unique_by(agents, lambda a: a.model, axis)
            )
        elif axis == HeterogeneityAxis.SYSTEM_PROMPT_FRAME:
            # Frame is the honor-system axis: agents with no frame skip
            # the check; agents that declare a frame must each have a
            # distinct one. (Free-text frames could be effectively
            # identical and the system will not flag it; semantic
            # similarity is a v2 candidate.)
            with_frame = [a for a in agents if a.frame is not None]
            violations.extend(
                _agents_unique_by(
                    with_frame, lambda a: a.frame or "", axis
                )
            )
        elif axis == HeterogeneityAxis.BINDING:
            relevant = [
                e
                for e in enrollments
                if e.binding is not None and e.agent_id in agent_ids
            ]
            violations.extend(_enrollments_unique_by_binding(relevant, axis))
    return violations


def _agents_unique_by(
    agents: Sequence[Agent],
    key_fn: Callable[[Agent], str],
    axis: HeterogeneityAxis,
) -> list[HeterogeneityViolation]:
    seen: dict[str, list[str]] = {}
    for a in agents:
        seen.setdefault(key_fn(a), []).append(a.id)
    return [
        HeterogeneityViolation(
            axis=axis,
            duplicate_value=key,
            affected_agent_ids=ids,
        )
        for key, ids in seen.items()
        if len(ids) > 1
    ]


def _enrollments_unique_by_binding(
    enrollments: Sequence[Enrollment],
    axis: HeterogeneityAxis,
) -> list[HeterogeneityViolation]:
    """Stable-key uniqueness check for arbitrary-dict bindings.

    JSON-serializing with ``sort_keys=True`` ensures ``{a:1,b:2}`` and
    ``{b:2,a:1}`` collapse to the same key.
    """
    seen: dict[str, list[str]] = {}
    for e in enrollments:
        if e.binding is None:
            continue
        key = json.dumps(e.binding, sort_keys=True)
        seen.setdefault(key, []).append(e.agent_id)
    return [
        HeterogeneityViolation(
            axis=axis,
            duplicate_value=key,
            affected_agent_ids=ids,
        )
        for key, ids in seen.items()
        if len(ids) > 1
    ]
