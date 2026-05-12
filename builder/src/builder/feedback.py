"""No-op FeedbackLoop stub. Builder is intentionally stateless in v1."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from jig.core.types import (
    EvalCase,
    FeedbackLoop,
    FeedbackQuery,
    Score,
    ScoredResult,
    ScoreSource,
)


class NoOpFeedback(FeedbackLoop):  # type: ignore[misc]
    async def store_result(
        self,
        content: str,
        input_text: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        return "noop"

    async def score(self, result_id: str, scores: list[Score]) -> None:
        return None

    async def get_signals(
        self,
        query: str,
        limit: int = 3,
        min_score: float | None = None,
        source: ScoreSource | None = None,
    ) -> list[ScoredResult]:
        return []

    async def query(self, q: FeedbackQuery) -> list[ScoredResult]:
        return []

    async def export_eval_set(
        self,
        since: datetime | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        limit: int | None = None,
    ) -> list[EvalCase]:
        return []
