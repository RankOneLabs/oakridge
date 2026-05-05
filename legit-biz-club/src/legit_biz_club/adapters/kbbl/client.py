"""Async HTTP client against kbbl's Hono server.

Stub for v1 PR #3 (foundation). Endpoint methods are wired up in PR #4
once kbbl PR #1 (artifact-scoped sessions) and PR #2 (inbox extension)
land. Method signatures here describe the intended surface so
legit-biz-club code can be written against typed stubs.
"""
from __future__ import annotations

import httpx

from legit_biz_club.adapters.kbbl.types import SessionSnapshot


class KbblClient:
    """Typed HTTP client against the local kbbl server.

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
        # Apply base_url + timeout to the owned client so endpoint
        # methods can use relative paths and inherit the configured
        # timeout. Without these, an injected `httpx.AsyncClient()`
        # would silently default to httpx's 5s timeout and require
        # callers to repeat the base URL on every request — making the
        # constructor args dead code.
        self._http = http or httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
        )

    async def list_sessions(self) -> list[SessionSnapshot]:
        """List sessions kbbl knows about.

        Stub. PR #4 wires this against ``GET /sessions`` once the
        artifact-scoped variant ships in kbbl PR #1.
        """
        raise NotImplementedError("PR #4 wires this against kbbl PR #1")

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()
