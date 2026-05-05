"""Polyglot adapter to kbbl (TypeScript operator surface).

The boundary through which legit-biz-club consumes kbbl. All cross-language
(Python ↔ TS) traffic flows through here. kbbl internals are opaque; if
kbbl's HTTP API changes, legit-biz-club breaks at exactly one place.

Trust model: Tailscale-network trust, same as kbbl uses today. legit-biz-club
runs on a Springfield machine on the Tailnet; no per-request auth.
"""

from legit_biz_club.adapters.kbbl.client import KbblClient
from legit_biz_club.adapters.kbbl.types import (
    ResultUsage,
    SessionSnapshot,
    SessionStatus,
)

__all__ = [
    "KbblClient",
    "ResultUsage",
    "SessionSnapshot",
    "SessionStatus",
]
