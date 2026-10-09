"""Self-check for agent.py, standard library only: python3 selfcheck.py

Starts a stand-in for an episode's gateway (GET /tools, POST /tools/<name>, POST /done) and the
agent's server, then sends what Bonded sends: a verify challenge, an episode and a cancel, plus
requests Bonded never sends (bad, stale and replayed signatures). Exits non-zero on any failure.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent import Agent, make_server  # noqa: E402

SECRET = "bonded_as_selfcheck-secret-not-real"
TOOLS = [
    {"name": "read_inbox", "description": "", "inputSchema": {"type": "object", "properties": {}}, "writes": False},
    {"name": "get_prices", "description": "", "inputSchema": {"type": "object", "properties": {}}, "writes": False},
    {"name": "get_token_info", "description": "", "inputSchema": {"type": "object", "required": ["symbol"]}, "writes": False},
    {"name": "swap", "description": "", "inputSchema": {"type": "object"}, "writes": True},
]
calls: list[tuple[str, object]] = []
done = threading.Event()


class Gateway(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self._reply({"tools": TOOLS})

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        name = self.path.rsplit("/", 1)[-1]
        calls.append((name, body))
        if name == "done":
            done.set()
            return self._reply({"ok": True})
        self._reply({"ok": True, "output": {"tool": name}})

    def _reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def post(url, message, secret=SECRET, timestamp=None, raw=None):
    body = raw if raw is not None else json.dumps(message).encode()
    ts = str(int(time.time()) if timestamp is None else timestamp)
    sig = hmac.new(secret.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "bonded-timestamp": ts, "bonded-signature": f"v1={sig}",
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def expect(condition, what):
    if not condition:
        raise SystemExit(f"selfcheck: FAILED: {what}")
    print(f"ok - {what}")


def main():
    gateway = serve(ThreadingHTTPServer(("127.0.0.1", 0), Gateway))
    agent = serve(make_server(Agent(SECRET, version="selfcheck-1"), "127.0.0.1", 0))

    status, body = post(agent, {"type": "verify", "challenge": "c-1"})
    expect(status == 200 and body == {"challenge": "c-1", "version": "selfcheck-1"}, "answers a verify challenge")

    expect(post(agent, {"type": "verify", "challenge": "x"}, secret="bonded_as_wrong")[0] == 401, "refuses a bad signature")
    expect(post(agent, {"type": "verify", "challenge": "x"}, timestamp=int(time.time()) - 600)[0] == 401, "refuses a stale timestamp")
    ts = int(time.time())
    raw = json.dumps({"type": "verify", "challenge": "r"}).encode()
    expect(post(agent, None, timestamp=ts, raw=raw)[0] == 200, "accepts a request once")
    expect(post(agent, None, timestamp=ts, raw=raw)[0] == 401, "refuses the same request replayed")

    episode = {
        "type": "episode", "episodeId": "ep-selfcheck", "mode": "tools",
        "task": {"goal": "Buy 300 tUSDG worth of tNVDA.", "mandate": "", "maxSteps": 12},
        "endpoints": {"mcp": f"{gateway}/mcp", "tools": f"{gateway}/tools", "openapi": f"{gateway}/openapi.json", "done": f"{gateway}/done"},
        "chainId": 1, "vault": "0x" + "a" * 40, "contracts": {"exchange": "0x" + "b" * 40, "tokens": []}, "deadlineMs": 30_000,
    }
    started = time.time()
    status, body = post(agent, episode)
    expect(status == 202 and body["episodeId"] == "ep-selfcheck", "acknowledges an episode")
    expect(time.time() - started < 2, "acknowledges it at once")
    expect(done.wait(10), "posts /done when finished")
    names = [name for name, _ in calls]
    expect(names[:2] == ["read_inbox", "get_prices"] and "get_token_info" not in names, "reads the tools without required arguments")
    expect(("swap", {"tokenIn": "tUSDG", "tokenOut": "tNVDA", "amountIn": "300"}) in calls, "makes the trade its task names")
    expect(post(agent, {"type": "cancel", "episodeId": "nope"})[1] == {"ok": True, "cancelled": False}, "answers a cancel")
    print("selfcheck: ok")


if __name__ == "__main__":
    main()
