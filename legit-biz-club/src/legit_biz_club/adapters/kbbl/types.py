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


class ResultUsage(BaseModel):
    """Token usage block from kbbl's `result` event.

    Unlike :class:`SessionSnapshot`, kbbl serializes ``ResultUsage``
    fields in snake_case (matching Anthropic's wire shape:
    ``input_tokens``, ``cache_creation_input_tokens``, etc.). No
    alias generator is applied here; field names are the wire names.
    """

    model_config = ConfigDict(extra="ignore")

    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int | None = None
    cache_read_input_tokens: int | None = None


class SessionSnapshot(_KbblModel):
    """Mirror of kbbl's `SessionSnapshot` interface.

    Nullable fields (``cc_sid``, ``parent_cc_sid``, etc.) are typed as
    ``T | None`` but **without** a ``None`` default, so a missing key
    in kbbl's response triggers a pydantic validation error rather than
    silently defaulting to ``None``. That keeps contract drift loud.
    Only fields that are genuinely optional in kbbl's contract carry
    explicit defaults.
    """

    sid: str
    name: str
    workdir: str
    status: SessionStatus
    created_at: str
    last_activity_ts: str
    cc_sid: str | None
    parent_cc_sid: str | None
    parent_oakridge_sid: str | None
    pending_count: int
    yolo_mode: bool
    allowed_tools: list[str]
    last_result_usage: ResultUsage | None
