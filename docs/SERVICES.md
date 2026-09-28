# Day 7 services

Run `pnpm test:services` for real Postgres and Anvil integration tests without Docker. Install Node 22+, pnpm 10.33.0 and Foundry first. `pnpm install` allows the embedded Postgres native setup script through the workspace allowlist.

For long-running services, set `DATABASE_URL`, `RPC_URL`, `DEPLOYMENT_FILE`, `ATTESTER_KEY`, `KEEPER_KEY` and `API_TOKEN` in `.env`. The API token must have at least 24 characters. Use separate attester and keeper accounts across deployed processes to avoid nonce contention. Both need testnet gas; only the attester must be registered with the registry. `ROLE` is `api`, `keeper`, `arena-worker` or `all`. Run `pnpm services`. Migrations run under a database lock before each role starts. `ROLE=migrate node apps/api/dist/main.js` runs migrations alone after building.

`docker compose up --build` runs Postgres 16 and all roles. Docker must be running and the configured RPC must be reachable inside the container. The image builds without git submodules: when `contracts/evm/lib` is empty (as in Railway's source snapshot), the Dockerfile fetches forge-std and OpenZeppelin at the commits the repository pins. If you update a submodule, update `FORGE_STD_COMMIT` or `OPENZEPPELIN_COMMIT` in the Dockerfile to match `git ls-tree HEAD contracts/evm/lib`.

## Railway

Railway detects the pnpm workspace and offers one service per package (`@bonded/arena`, `@bonded/api` and so on). Discard that suggestion: the packages are not separate services. Instead:

1. Add PostgreSQL.
2. Create three empty services, `api`, `keeper` and `arena-worker`. Connect each to this repository on `main` with the root directory left empty, so the root `Dockerfile` and `railway.json` are used.
3. Set `ROLE` to the service name on each one. Set `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`), `RPC_URL` and `DEPLOYMENT_FILE` on all three, `ATTESTER_KEY` on `api` and `arena-worker`, `API_TOKEN` on `api` and `KEEPER_KEY` on `keeper`.
4. Only on `api`: generate a public domain and set the health check path to `/health`. The worker and keeper have no HTTP listener.
5. Turn sleeping off on all three.

Railway injects `PORT`; the API reads it. Every service runs migrations under a database lock before starting, so start order does not matter.

Provision agents through `AGENTS_FILE`, a JSON array of `{ "kind": "hardened", "mandate": <full EVM mandate>, "codeHash": "0x…" }` records. `kind` is `hardened` or `vulnerable`, selecting the existing scripted demo adapter. Agent IDs must already exist on the configured chain; the mandate's chain and agent ID must match. Keep this file server-owned. On startup, a supplied file is the complete configured set for that chain: removed agents are disabled and their queued/running jobs are failed (active workers stop at their next lease check), while historical reports and attestations remain readable. An empty array disables the entire chain's configured set; omitting `AGENTS_FILE` leaves it unchanged. Already-broadcast transactions cannot be cancelled. Arbitrary submitted agent code and LLM configurations are outside this initial worker interface.

POST endpoints require `Authorization: Bearer <API_TOKEN>`. GET endpoints are public.

| Request | Body / result |
|---|---|
| `GET /health` | Database availability and configured chain ID |
| `POST /arena/runs` | `{ "agentId": "1" }` → `runId` |
| `GET /arena/runs/:id` | Status, report and retry error |
| `GET /arena/runs/:id/report` | Report or 202 while pending |
| `GET /agents/:id/score` | Latest worker-posted signed attestation and transaction hash |
| `POST /quotes` | `{ "agentId": "1", "vault": "0x…", "coverAmount": "20000000000" }` → signed quote |
| `GET /events?runId=<uuid>` | SSE episode feed; optional run filter, `Last-Event-ID` replay |

Amounts are integer strings in base-asset units. Quotes use the registry score and one block's pool exposure, bond and caps, then simulate `buyCover` as the guardian. Quotes do not reserve capacity: chain state can change before purchase, and the contract checks again. Missing or invalid chain state currently returns a generic 503; underwriting cap failures return 409.

The report endpoint returns the exact JSON bytes hashed by the attestation; a text column preserves them alongside the queryable JSONB report. Migration 2 adds this column without fabricating original bytes for older rows.

The worker rates on a local fork, never against the live RPC. It awaits every episode write, saves the report and signature, then posts the attestation to the configured registry. Jobs get at most three attempts, including expired leases from process crashes, and then remain `failed` for inspection. The next claim reaps exhausted leases, updates rating status and emits a failure event. `events` retains history without pruning; configure retention before sustained public traffic. SSE admits at most five simultaneous subscribers per API instance, returning 503 beyond the limit. Each stream reuses its reserved listener for replay queries, leaving the rest of the 15-connection pool for ordinary operations. Connection waits and stream queries time out after five seconds. Shutdown stops admission, aborts active streams (including slow readers), waits for listener cleanup, and then closes Postgres.

The keeper scans up to 500 blocks per tick, with five confirmations by default (`KEEPER_CONFIRMATIONS=0` only for local tests). It accrues active policies every minute. Breaches stay pending after RPC or liquidity failures. No-match breaches become `ignored` with a reason once the policy cursor has passed the breach timestamp; until then they remain pending so a not-yet-indexed policy at the same timestamp is not missed. Claims are checked against historical coverage windows and simulated after accrual. A deep reorg triggers an error and stops scanning until an operator reconciles the database. Monitor service error logs and pending jobs; this initial deployment does not include an alerting integration.
