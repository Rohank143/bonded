# ADR-008: Hosting, storage and deploys for the off-chain services

- **Status:** Accepted
- **Date:** 2026-09-28
- **Code:** `apps/api/`, `apps/keeper/`, `apps/arena/`, `Dockerfile`, `docker-compose.yml`, `.railway/railway.ts` (from Day 7)

## Context

Bonded has to be live, not just runnable on a laptop. From Day 7 there are three long-running off-chain services:
- **API** (Section 14.1): REST plus SSE live feeds. SSE holds connections open.
- **Keeper** (Section 14.2): polls every chain for breaches, files claims and accrues premiums. It never stops.
- **Arena worker:** runs rating jobs queued through the API (`POST /arena/runs`), so anyone can start a rating from the web app and watch it live.

The plan originally said "Postgres, with jobs on pg-boss" (Section 14.1), but it named no host, no migration tool, no local database setup and no deploy flow.

Serverless functions (Vercel-style) don't fit any of these: functions time out, so they can't hold SSE connections, run a polling loop or run a two-minute rating.

**Measured size of a rating run** (Day 6 code, vulnerable-agent, scripted brain, 42 episodes, on an Apple-silicon Mac): about 220 MB peak for Node plus 50 MB for anvil, 136 s wall time, about 6 s of CPU. A run is mostly waiting, not computing, so it needs little CPU and well under 512 MB.

## Decisions

### 1. Postgres everywhere, one connection string

- **Local:** `docker compose up db` starts Postgres 16. Integration tests use `embedded-postgres` (real Postgres 18 binaries), so Docker is optional.
- **Live:** Railway Postgres (decision 3).
- Code reads only `DATABASE_URL`. Nothing in the code knows which host it runs on.
- **Schema and migrations:** Drizzle. Migrations are plain SQL files committed in the repo. They run as a pre-deploy step (`pnpm db:migrate`), so new code never runs against an old schema, and a failed migration stops the deploy.
- **Jobs:** a Postgres `FOR UPDATE SKIP LOCKED` queue on the same database: Arena rating runs, queued by the API and taken by the worker.

What the database holds: agents, rating runs and reports, attestations, signed quotes (with their nonces), the keeper's per-chain block cursor, and the events it has seen and handled.

### 2. The keeper is restart-safe by design

Any host restarts services (deploys, crashes, maintenance). The keeper must lose nothing when that happens:
- **Block cursor in Postgres, per chain.** On start the keeper reads from the last processed block, not from "now", so it catches up on anything it missed.
- **Idempotent claims.** The contract already rejects a breach that has been claimed, so filing twice fails safely. The keeper records what it filed and checks on-chain state before sending.
- **The contracts give slack.** A breach can still be claimed for 7 days after the policy ends (`ClaimsEngine.claimWindow`), and an unpaid premium has a 3-day grace period before lapse (`CoverManager.gracePeriod`). A keeper outage of minutes or hours delays a claim; it never loses one.
- **Anyone can file.** `fileClaim` and `accrue` are permissionless, so a vault guardian can file a claim themselves if the keeper is down.

### 3. Railway for the services and Postgres; Vercel for the frontend

| Piece | Host | Notes |
|---|---|---|
| API | Railway service (`ROLE=api`) | Public domain; REST and SSE |
| Keeper | Railway service (`ROLE=keeper`) | No public domain |
| Arena worker | Railway service (`ROLE=arena-worker`) | No public domain; runs one rating at a time |
| Postgres | Railway Postgres, same project | `DATABASE_URL` is shared with the three services as a reference variable |
| Frontend (`apps/web`, from Day 12) | Vercel, Hobby plan | Vite + React static build (ADR-010); calls the API, which allows its origin through `WEB_ORIGINS` |

Why Railway:
- One project holds all three services and the database, with no cross-provider connection setup.
- Each piece is its own service, so a crashed or oversized rating run can't take down the API or the keeper.
- Services stay on (no sleeping), so there are no cold starts.
- Billing is per second of actual use. An idle API and keeper use little, so the bill stays close to the Hobby plan's included usage.

Settings:
- **App sleeping stays off** for all three services. The keeper must keep polling.
- **A usage limit is set** in the Railway dashboard, so a bug (for example a runaway worker) can't run up a large bill.
- **The three services never call each other over the network.** They share Postgres: jobs go through a Postgres `FOR UPDATE SKIP LOCKED` queue, and live events go through Postgres `LISTEN/NOTIFY`, which the API turns into SSE. There's no internal networking to set up.

**Pricing (Railway's published rates, September 2026; check again when the account is created):** the Hobby plan is $5 a month and includes $5 of usage; usage beyond that is billed per second at $20 per vCPU-month and $10 per GB-month of RAM.

### 4. One Docker image, one role per service

- `apps/api`, `apps/keeper` and `apps/arena` stay separate packages with their own tests.
- One `Dockerfile` builds them all, with Foundry's `anvil` installed for the Arena. `ROLE` picks what a container runs: `api`, `keeper`, `arena-worker`, or `all` (all three in one process, for local development).
- The Arena worker takes one job at a time from the Postgres `FOR UPDATE SKIP LOCKED` queue and streams each episode as an event, so the web app's live attack feed shows the run as it happens. A queued job waits if the worker is busy or restarting; it isn't lost.

### 5. Deploys

- Railway deploys each service from GitHub **on every merge to `main`**. The founder merges every PR, so nothing reaches the live services without review.
- Build and deploy settings live in `.railway/railway.ts` in the repo (Railway infrastructure as code), not only in the dashboard. `railway config plan` shows drift; `railway config apply` applies the file after merge. It replaced `railway.json`, which Railway deprecated.
- CI is paused (billing issue), so the full pipeline still runs on a fresh clone before each PR is opened, and the results go in the PR description.

### 6. Secrets

Set in Railway's service variables (and Vercel's for the frontend), never in the repo:
- `DATABASE_URL`: provided by Railway Postgres.
- `ATTESTER_KEY` (API and Arena worker): signs attestations and quotes. Section 14.1 already put it in an environment secret for the hackathon; a KMS or threshold signer comes later.
- `KEEPER_KEY` (keeper and Arena worker): pays gas for `fileClaim`, `accrue` and attestation posting. It holds only testnet gas money and has no special rights, since those calls are permissionless.
- `OPENROUTER_API_KEY` (Arena worker): only for ratings that use an LLM brain. Each run keeps its `--max-usd` spending cap.
- RPC URLs per chain.

All keys are testnet-only. `.env.example` lists every variable as each one is added in code.

## Consequences

- **Cost:** the Hobby plan plus any usage above its included amount, capped by the usage limit.
- **Moving hosts needs no code changes.** The same image runs on any Docker host (Render, Fly.io, a VPS with `docker compose`), one container per `ROLE`.
- **What isn't covered:** there's no high availability. If Railway is down, the API and the live feed are down. Claims are still safe (decision 2), and queued ratings wait.
- **To verify on the live service:** rating time and memory on Railway's hardware. The numbers in Context were measured on a Mac.

## Day 7 queue details

The Day 7 scope replaces pg-boss with a small SQL queue. Workers claim jobs using `FOR UPDATE SKIP LOCKED`, renew a 60-second lease every 15 seconds, and fence completion with a lease token. A per-chain advisory lock permits one rating worker at a time. Failed jobs retry after 30 seconds, up to three attempts. Completed reports and signed attestations persist before posting; retries recover an accepted transaction from its validation digest. Live events persist before `NOTIFY`, and SSE supports `Last-Event-ID` replay.

Keeper log ingestion commits its cursor with discovered vaults, policies and breaches. Claim failures remain pending independently of the cursor. Historical policies remain available after cancellation or expiry. Five confirmation blocks are the default; a cursor hash mismatch stops ingestion for operator reconciliation. This detects deep reorgs but does not automatically roll them back.
