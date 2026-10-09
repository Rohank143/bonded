"""A Bonded Agent URL endpoint in plain Python (standard library only).

Bonded POSTs one signed JSON message per call:

- {"type": "verify", "challenge": ...}  when you register the URL: answer 200 {"challenge", "version"}.
- {"type": "episode", ...}              an Arena episode: answer 2xx within 10 seconds, then work.
- {"type": "cancel", "episodeId": ...}  stop that episode (best effort).

Every call carries `bonded-timestamp` (unix seconds) and
`bonded-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Check both before
reading the message: an unsigned request could be anyone.

Run it:  BONDED_AGENT_SECRET=bonded_as_... PORT=8080 python3 agent.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOLERANCE_SECONDS = 300
MAX_BODY_BYTES = 1024 * 1024


class SignatureChecker:
    """Checks Bonded's signatures, and refuses a (timestamp, signature) pair seen before."""

    def __init__(self, secret: str, tolerance: int = TOLERANCE_SECONDS):
        self.secret = secret.encode()
        self.tolerance = tolerance
        self.seen: dict[str, int] = {}
        self.lock = threading.Lock()

    def check(self, timestamp: str | None, signature: str | None, body: bytes, now: float | None = None) -> str | None:
        """None when the request is Bonded's; otherwise why not."""
        if not timestamp or not signature:
            return "missing bonded-timestamp or bonded-signature"
        if not re.fullmatch(r"\d{1,12}", timestamp):
            return "malformed bonded-timestamp"
        now = int(time.time() if now is None else now)
        if abs(now - int(timestamp)) > self.tolerance:
            return "the timestamp is too far from this server's clock"
        expected = hmac.new(self.secret, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        candidates = [p.strip()[3:] for p in signature.split(",") if p.strip().startswith("v1=")]
        # compare_digest takes the same time whatever the input, so the signature can't be guessed byte by byte.
        if not any(hmac.compare_digest(expected, c) for c in candidates):
            return "the signature doesn't match"
        key = f"{timestamp}.{signature}"
        with self.lock:
            for k, expires in list(self.seen.items()):
                if expires < now:
                    del self.seen[k]
            if key in self.seen:
                return "this request was already received (replayed)"
            self.seen[key] = int(timestamp) + self.tolerance
        return None


def http_json(method: str, url: str, body: object | None = None, timeout: float = 30) -> object:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"null")


TASK_TRADE = re.compile(r"\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b", re.I)


def run_episode(episode: dict, cancelled: threading.Event) -> None:
    """One episode: read everything (as data), do the task, then POST /done.

    This agent follows rules so the example needs no model. A real agent would hand the tools
    (GET {tools} lists them with JSON schemas) to its model here, and stop when `cancelled` is set.
    """
    tools_url = episode["endpoints"]["tools"].rstrip("/")
    call = lambda name, args=None: http_json("POST", f"{tools_url}/{name}", args or {})  # noqa: E731

    listed = http_json("GET", tools_url)["tools"]
    read = 0
    for tool in listed:
        if cancelled.is_set():
            return
        if tool["writes"] or tool["inputSchema"].get("required"):
            continue
        if call(tool["name"]).get("ok"):
            read += 1

    outcome = "no trade"
    asked = TASK_TRADE.search(episode["task"]["goal"])
    if asked and episode["mode"] == "tools" and not cancelled.is_set():
        amount, token_in, token_out = asked.group(1).replace(",", ""), asked.group(2), asked.group(3)
        result = call("swap", {"tokenIn": token_in, "tokenOut": token_out, "amountIn": amount})
        outcome = "swapped" if result.get("ok") else f"swap refused: {result.get('error')}"

    if not cancelled.is_set():
        http_json("POST", episode["endpoints"]["done"], {
            "finalMessage": f"read {read} sources, acted on none of them; {outcome}",
            # Report your model's usage here ({"inputTokens", "outputTokens", "costUsd"}) so Bonded
            # can estimate what a full rating costs you. This agent uses no model.
        })


class Agent:
    def __init__(self, secret: str, version: str | None = None):
        self.signatures = SignatureChecker(secret)
        self.version = version
        self.running: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    def handle(self, headers, body: bytes) -> tuple[int, dict]:
        problem = self.signatures.check(headers.get("bonded-timestamp"), headers.get("bonded-signature"), body)
        if problem:
            return 401, {"error": problem}
        try:
            message = json.loads(body)
        except ValueError:
            return 400, {"error": "the body isn't JSON"}
        kind = message.get("type") if isinstance(message, dict) else None

        if kind == "verify":
            if not isinstance(message.get("challenge"), str):
                return 400, {"error": "verify needs a challenge string"}
            return 200, {"challenge": message["challenge"], **({"version": self.version} if self.version else {})}

        if kind == "cancel":
            with self.lock:
                event = self.running.get(message.get("episodeId"))
            if event:
                event.set()
            return 200, {"ok": True, "cancelled": event is not None}

        if kind == "episode":
            episode_id = message.get("episodeId")
            if not isinstance(episode_id, str) or not isinstance(message.get("endpoints"), dict):
                return 400, {"error": "not a valid episode"}
            with self.lock:
                if episode_id in self.running:
                    return 200, {"ok": True, "episodeId": episode_id, "alreadyRunning": True}
                cancelled = self.running[episode_id] = threading.Event()
            # Answer now (Bonded waits at most 10 seconds) and work in the background, up to the deadline.
            deadline = threading.Timer(message.get("deadlineMs", 60_000) / 1000, cancelled.set)
            deadline.daemon = True
            deadline.start()
            threading.Thread(target=self._run, args=(message, cancelled), daemon=True).start()
            return 202, {"ok": True, "episodeId": episode_id}

        return 400, {"error": "unknown message type"}

    def _run(self, episode: dict, cancelled: threading.Event) -> None:
        try:
            run_episode(episode, cancelled)
        except Exception as error:  # noqa: BLE001 - report any failure to the operator's log
            print(f"episode {episode['episodeId']} failed: {error}", flush=True)
        finally:
            with self.lock:
                self.running.pop(episode["episodeId"], None)


def make_server(agent: Agent, host: str = "0.0.0.0", port: int = 8080) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server's naming
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY_BYTES:
                return self._reply(413, {"error": "the body is too large"})
            # Verify the raw bytes exactly as received: re-encoding parsed JSON would change them.
            status, reply = agent.handle(self.headers, self.rfile.read(length))
            self._reply(status, reply)

        def do_GET(self):  # noqa: N802
            self._reply(405, {"error": "Bonded calls this endpoint with POST"})

        def _reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # quiet
            pass

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    secret = os.environ.get("BONDED_AGENT_SECRET")
    if not secret:
        raise SystemExit("set BONDED_AGENT_SECRET to the agent secret Bonded showed you")
    port = int(os.environ.get("PORT", "8080"))
    server = make_server(Agent(secret, os.environ.get("AGENT_VERSION")), os.environ.get("HOST", "0.0.0.0"), port)
    print(f"listening on :{server.server_address[1]}", flush=True)
    server.serve_forever()
