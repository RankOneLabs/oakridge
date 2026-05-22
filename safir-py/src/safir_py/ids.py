from __future__ import annotations

from typing import NewType

TaskId = NewType("TaskId", int)
PlanId = NewType("PlanId", str)
PhaseId = NewType("PhaseId", str)
RunId = NewType("RunId", str)
HandoffId = NewType("HandoffId", str)
BriefId = NewType("BriefId", str)
ThreadId = NewType("ThreadId", str)
