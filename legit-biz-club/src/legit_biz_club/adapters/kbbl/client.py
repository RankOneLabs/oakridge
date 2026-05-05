"""Async HTTP client against kbbl's Hono server.

Wraps the kbbl endpoints legit-biz-club consumes:

- ``POST /sessions`` — spawn a session, optionally artifact-tagged
- ``GET /sessions`` — list all sessions kbbl knows about
- ``GET /artifacts/{artifactId}/sessions`` — list sessions for one artifact
- ``POST /inbox/workspace-events`` — push project events to the inbox

Methods raise on non-2xx responses (httpx default). Trust model:
Tailscale-network trust, no per-request auth. ``base_url`` defaults to
kbbl's local default; override for remote / test instances.
"""
from __future__ import annotations

from typing import Any

import httpx

from legit_biz_club.adapters.kbbl.types import SessionSnapshot


class KbblClient:
    """Typed async HTTP client against the local kbbl server.

    Trust: assumes Tailscale-network trust. ``base_url`` defaults to
    kbbl's local default (127.0.0.1:8788); override for remote/test
    instances. The client owns its httpx transport unless one is
    injected for testing.
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8788",
        *,
        http: httpx.AsyncClient | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient()

    async def list_sessions(self) -> list[SessionSnapshot]:
        """``GET /sessions`` — every session kbbl knows about, in-memory only."""
        response = await self._http.get(
            f"{self._base_url}/sessions",
            timeout=self._timeout,
        )
        response.raise_for_status()
        body = response.json()
        return [
            SessionSnapshot.model_validate(s) for s in body.get("sessions", [])
        ]

    async def list_artifact_sessions(
        self, artifact_id: str
    ) -> list[SessionSnapshot]:
        """``GET /artifacts/{artifactId}/sessions`` — sessions tagged with this artifact."""
        if not artifact_id:
            raise ValueError("artifact_id must be non-empty")
        response = await self._http.get(
            f"{self._base_url}/artifacts/{artifact_id}/sessions",
            timeout=self._timeout,
        )
        response.raise_for_status()
        body = response.json()
        return [
            SessionSnapshot.model_validate(s) for s in body.get("sessions", [])
        ]

    async def create_artifact_session(
        self,
        *,
        workdir: str,
        artifact_id: str,
        name: str | None = None,
    ) -> SessionSnapshot:
        """``POST /sessions`` with an ``artifact_id`` body field.

        Returns the freshly-created session's snapshot. The artifact tag
        flows through to ``listByArtifact`` on the kbbl side and the
        operator UI; kbbl treats it as opaque.
        """
        if not artifact_id:
            raise ValueError("artifact_id must be non-empty")
        body: dict[str, Any] = {
            "workdir": workdir,
            "artifact_id": artifact_id,
        }
        if name is not None:
            body["name"] = name
        response = await self._http.post(
            f"{self._base_url}/sessions",
            json=body,
            timeout=self._timeout,
        )
        response.raise_for_status()
        return SessionSnapshot.model_validate(response.json())

    async def post_workspace_event(
        self,
        *,
        kind: str,
        project_id: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """``POST /inbox/workspace-events`` — push a project event to the inbox.

        kbbl treats the event as opaque pass-through. ``kind`` and
        ``project_id`` are required and must be non-empty; ``payload``
        defaults to ``{}`` if omitted.
        """
        if not kind:
            raise ValueError("kind must be non-empty")
        if not project_id:
            raise ValueError("project_id must be non-empty")
        # Body uses camelCase to match kbbl's TS shape — the route
        # accepts ``projectId`` and ``payload`` directly.
        body: dict[str, Any] = {"kind": kind, "projectId": project_id}
        if payload is not None:
            body["payload"] = payload
        response = await self._http.post(
            f"{self._base_url}/inbox/workspace-events",
            json=body,
            timeout=self._timeout,
        )
        response.raise_for_status()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()
