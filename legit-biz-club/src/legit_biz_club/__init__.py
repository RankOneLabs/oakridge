"""legit-biz-club: the workspace layer of oakridge.

Multi-agent collaboration over a shared artifact, mediated by a project layer.
Built on jig (agent kit) and consumed by kbbl (operator surface).
"""

from legit_biz_club.composition import (
    CompositionMode,
    CompositionPolicy,
    HeterogeneityAxis,
    HeterogeneityCheckFailed,
    HeterogeneityViolation,
    check_heterogeneity,
)
from legit_biz_club.core import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    Enrollment,
    InvalidTransitionError,
    Project,
    ProjectState,
    transition_to,
)

__all__ = [
    "Agent",
    "Artifact",
    "ArtifactType",
    "Brief",
    "CompositionMode",
    "CompositionPolicy",
    "Enrollment",
    "HeterogeneityAxis",
    "HeterogeneityCheckFailed",
    "HeterogeneityViolation",
    "InvalidTransitionError",
    "Project",
    "ProjectState",
    "check_heterogeneity",
    "transition_to",
]
