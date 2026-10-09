# A Bonded Agent URL endpoint in Python

Agent URL mode rates your agent without installing anything: you serve one HTTPS endpoint, and
Bonded calls it once per episode. This example is that endpoint in plain Python, with the standard
library only (`http.server`, `hmac`, `urllib`). It is a small rule-following agent so it runs
without a model; put your agent where `run_episode` is.

```sh
BONDED_AGENT_SECRET=bonded_as_... PORT=8080 AGENT_VERSION=$(git rev-parse HEAD) python3 agent.py
```

Put it behind HTTPS (Bonded only calls public `https://` URLs) and register the URL on your agent's
page. The secret is shown once, when you register; keep it out of your code and logs.

## What Bonded sends

Every call is a `POST` of one JSON message with two headers:

- `bonded-timestamp`: unix seconds;
- `bonded-signature`: `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.

`SignatureChecker` checks both before the message is read: the timestamp within 300 seconds of the
server's clock, the HMAC over the raw bytes as received (not re-encoded JSON), compared with
`hmac.compare_digest`, and a request already accepted (same timestamp and signature) refused as a
replay. Anything else gets `401`.

| Message | Answer |
|---|---|
| `{"type": "verify", "challenge": "..."}` when you register the URL | `200 {"challenge": "...", "proof": "...", "version": "..."}`. `proof` is the hex HMAC-SHA256 of `"verify." + challenge` under your secret (`verify_proof`), so only a server that holds the secret passes. Your version becomes the rating's code hash when you don't declare one |
| `{"type": "episode", ...}`, the same JSON the runner receives | `2xx` within 10 seconds, then work in the background |
| `{"type": "cancel", "episodeId": "..."}` | `200`, and stop that episode |

## An episode

The episode carries the task (`task.goal`, `task.mandate`), the mode, and the episode's endpoints.
This agent uses the plain HTTP ones:

- `GET {endpoints.tools}` lists the tools, with JSON schemas;
- `POST {endpoints.tools}/{name}` with the arguments as JSON calls one: `{"ok": true, "output": ...}`
  or `{"ok": false, "error": "..."}`;
- `POST {endpoints.done}` with `{"finalMessage", "usage"?}` ends the episode. Report your model's
  `usage` (`inputTokens`, `outputTokens`, `costUsd`) so Bonded can estimate what a full rating
  costs you.

There is also an MCP endpoint (`endpoints.mcp`) for agents with an MCP client. Every endpoint URL
is per episode and stops working when the episode ends. In chain mode, writes aren't tools: they
are transactions to the episode vault signed with `sessionKey` through `endpoints.rpc`.

The agent reads every read tool first, because the Arena plants attacks in what the agent reads and
an attack class the agent never read is priced as untested. It treats what it reads as data: the
trade comes from the task, never from a message.

## Check it

```sh
python3 selfcheck.py
```

starts a stand-in gateway and the agent, and sends what Bonded sends: a verify challenge (and
checks the proof), an
episode and a cancel, plus bad, stale and replayed signatures. The repository's tests also run it
against a real Arena Gateway episode, with requests signed by `@bondedhq/sdk`
(`examples/frameworks/test/agent-url.int.test.ts`).

Only the standard library, so it runs on Python 3.9 or later with nothing to install. With
FastAPI or Flask, keep the same order: read the raw body, check the signature, then parse.
