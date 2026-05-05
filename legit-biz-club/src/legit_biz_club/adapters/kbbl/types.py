"""Pydantic models mirroring kbbl's TS types.

Hand-written to match kbbl's exported shapes. A drift smoke test
(``tests/test_kbbl_contract.py``, added in PR #4 when adapter consumption
goes live) hits each kbbl endpoint with known input and validates response
shape against these models. OpenAPI generation is deferred to v2.

kbbl serializes JSON in camelCase; this module's pydantic config pairs
Python snake_case attribute names with camelCase JSON aliases via
``alias_generator``.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _KbblModel(BaseModel):
    """Base for kbbl-shaped types — camelCase JSON, snake_case Python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


SessionStatus = Literal["starting", "live", "ended"]


class ResultUsage(_KbblModel):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int | None = None
    cache_read_input_tokens: int | None = None


class SessionSnapshot(_KbblModel):
    sid: str
    name: str
    workdir: str
    status: SessionStatus
    created_at: str
    last_activity_ts: str
    cc_sid: str | None = None
    parent_cc_sid: str | None = None
    parent_oakridge_sid: str | None = None
    artifact_id: str | None = None
    pending_count: int
    yolo_mode: bool
    allowed_tools: list[str]
    last_result_usage: ResultUsage | None = None
