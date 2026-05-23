"""Mock payload helpers for HTTP fixtures.

The typed pydantic models in safir-py require complete server payloads.
These helpers produce minimally-valid dicts that pass `model_validate`,
keyed by overrides per test.
"""
from __future__ import annotations

from typing import Any


def atom_edit_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "edit-1",
        "target_type": "plan",
        "target_id": "p1",
        "anchor": "anchor",
        "prev_value": None,
        "new_value": "value",
        "edited_by": "agent",
        "thread_id": "t1",
        "created_at": "2026-05-22T00:00:00Z",
    }
    base.update(overrides)
    return base


def thread_message_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "msg-1",
        "thread_id": "t1",
        "author": "agent",
        "body": "",
        "related_edit_id": None,
        "created_at": "2026-05-22T00:00:00Z",
    }
    base.update(overrides)
    return base
