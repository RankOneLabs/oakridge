#!/usr/bin/env python3
"""
Minimal HTTP listener for Phase 0 hook-firing verification.

Listens on 127.0.0.1:19876, records every POST (event type + body), and
for PermissionRequest returns a hookSpecificOutput decision of "allow" so
the CC session can proceed autonomously.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

_events: list[dict[str, Any]] = []
_lock = threading.Lock()


def get_events() -> list[dict[str, Any]]:
    with _lock:
        return list(_events)


def clear_events() -> None:
    with _lock:
        _events.clear()


class HookHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        pass  # suppress default access log noise

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = {"_raw": raw.decode(errors="replace")}

        # Extract event name from path: /hook/<EventName>
        path = self.path
        event_name = path[len("/hook/"):] if path.startswith("/hook/") else path.lstrip("/")

        record = {"event": event_name, "path": self.path, "body": body}
        with _lock:
            _events.append(record)

        print(f"[hook] {event_name}: {json.dumps(body)[:200]}", flush=True)

        # For PermissionRequest: auto-approve so the session can proceed.
        # Return the hookSpecificOutput format CC expects.
        if event_name == "PermissionRequest":
            resp = json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "phase0 auto-approve",
                }
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")


def start(port: int = 19876) -> HTTPServer:
    server = HTTPServer(("127.0.0.1", port), HookHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"[hook-listener] running on 127.0.0.1:{port}", flush=True)
    return server
