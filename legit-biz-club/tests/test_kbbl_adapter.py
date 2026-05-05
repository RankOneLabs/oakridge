"""Tests for the kbbl HTTP client adapter.

Uses ``httpx.MockTransport`` to capture requests and synthesize
responses without standing up a real kbbl server. Verifies the request
shape (method, URL, body) and that responses are validated through the
pydantic types.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from legit_biz_club.adapters.kbbl import KbblClient, SessionSnapshot

_FIXTURE_SNAPSHOT: dict[str, Any] = {
    "sid": "s-1",
    "name": "test-session",
    "workdir": "/tmp/repo",
    "status": "starting",
    "createdAt": "2026-05-04T10:00:00.000Z",
    "lastActivityTs": "2026-05-04T10:00:00.000Z",
    "ccSid": None,
    "parentCcSid": None,
    "parentOakridgeSid": None,
    "artifactId": "art-42",
    "pendingCount": 0,
    "yoloMode": False,
    "allowedTools": [],
    "lastResultUsage": None,
}


async def test_create_artifact_session_posts_correct_body() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_FIXTURE_SNAPSHOT)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        snap = await client.create_artifact_session(
            workdir="/tmp/repo", artifact_id="art-42", name="test-session"
        )

    assert captured["method"] == "POST"
    assert captured["path"] == "/sessions"
    assert captured["body"] == {
        "workdir": "/tmp/repo",
        "artifact_id": "art-42",
        "name": "test-session",
    }
    assert isinstance(snap, SessionSnapshot)
    assert snap.artifact_id == "art-42"
    assert snap.sid == "s-1"


async def test_create_artifact_session_omits_optional_name() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_FIXTURE_SNAPSHOT)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        await client.create_artifact_session(
            workdir="/tmp/repo", artifact_id="art-42"
        )
    # name not in body when omitted — kbbl applies its own server-side default.
    assert "name" not in captured["body"]


async def test_create_artifact_session_rejects_empty_artifact_id() -> None:
    client = KbblClient()
    try:
        with pytest.raises(ValueError):
            await client.create_artifact_session(workdir="/tmp", artifact_id="")
    finally:
        await client.aclose()


async def test_list_artifact_sessions() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        return httpx.Response(
            200, json={"sessions": [_FIXTURE_SNAPSHOT, _FIXTURE_SNAPSHOT]}
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        sessions = await client.list_artifact_sessions("art-42")
    assert captured["method"] == "GET"
    assert captured["path"] == "/artifacts/art-42/sessions"
    assert len(sessions) == 2
    assert all(isinstance(s, SessionSnapshot) for s in sessions)


async def test_post_workspace_event_sends_camelcase() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        await client.post_workspace_event(
            kind="proposal_applied",
            project_id="p-1",
            payload={"agent_id": "a-2", "version": "abc123"},
        )
    assert captured["method"] == "POST"
    assert captured["path"] == "/inbox/workspace-events"
    # kbbl's TS shape is camelCase — projectId, payload — and the body
    # forwards as-is. payload contents stay snake_case (legit-biz-club
    # vocabulary).
    assert captured["body"] == {
        "kind": "proposal_applied",
        "projectId": "p-1",
        "payload": {"agent_id": "a-2", "version": "abc123"},
    }


async def test_post_workspace_event_omits_payload_when_none() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        await client.post_workspace_event(kind="x", project_id="p-1")
    # payload omitted from body — kbbl defaults it server-side.
    assert "payload" not in captured["body"]


async def test_post_workspace_event_rejects_empty_kind() -> None:
    client = KbblClient()
    try:
        with pytest.raises(ValueError):
            await client.post_workspace_event(kind="", project_id="p-1")
    finally:
        await client.aclose()


async def test_post_workspace_event_rejects_empty_project_id() -> None:
    client = KbblClient()
    try:
        with pytest.raises(ValueError):
            await client.post_workspace_event(kind="x", project_id="")
    finally:
        await client.aclose()


async def test_raises_on_non_2xx() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "bad request"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        client = KbblClient(http=http)
        with pytest.raises(httpx.HTTPStatusError):
            await client.list_artifact_sessions("art-42")
