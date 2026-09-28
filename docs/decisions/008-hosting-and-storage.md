# ADR-008: Hosting, storage and deploys for the API and keeper

- **Status:** Accepted
- **Date:** 2026-09-28
- **Code:** `apps/api/`, `apps/keeper/`, `docker-compose.yml`, `Dockerfile` (from Day 7)

## Context

Bonded has to be live, not just runnable on a laptop. From Day 7 there are two long-running off-chain services:
- **API** (Section 14.1): REST plus SSE live feeds. SSE holds connections open.
- **Keeper** (Section 14.2): polls every chain for breaches, files claims and accrues premiums. It never stops.

The plan already said "Postgres, with jobs on `pg-boss`" (Section 14.1), but it named no host, no migration tool, no local database setup and no deploy flow. The founder wants free hosting for the hackathon; Railway was ruled out because it isn't free.

Serverless functions (Vercel-style) don't fit either service: functions time out, so they can't hold SSE connections or run a polling loop.

## Decisions

### 1. Postgres everywhere, one connection string

- **Local:** `docker compose up db` starts Postgres 16. The one-command demo starts it for you.
- **Live:** managed Postgres (decision 3).
- Code reads only `DATABASE_URL`. Nothing in the code knows which host it runs on.
- **Schema and migrations:** Drizzle. Migrations are plain SQL files committed in the repo, and they run automatically when the service starts (`pnpm db:migrate`), so a deploy can't run new code against an old schema.
- **Jobs:** `pg-boss` on the same database (for example, Arena rating runs started through the API).

What the database holds: agents, rating runs and reports, attestations, signed quotes (with their nonces), the keeper's per-chain block cursor, and the events it has seen and handled.

### 2. The keeper is restart-safe by design

A free host can restart or sleep the service. The keeper must lose nothing when that happens:
- **Block cursor in Postgres, per chain.** On start the keeper reads from the last processed block, not from "now", so it catches up on anything it missed.
- **Idempotent claims.** The contract already rejects a breach that has been claimed, so filing twice fails safely. The keeper records what it filed and checks on-chain state before sending.
- **The contracts give slack.** A breach can still be claimed for 7 days after the policy ends (`ClaimsEngine.claimWindow`), and an unpaid premium has a 3-day grace period before lapse (`CoverManager.gracePeriod`). A keeper outage of minutes or hours delays a claim; it never loses one.
- **Anyone can file.** `fileClaim` and `accrue` are permissionless, so a vault guardian can file a claim themselves if the keeper is down.

### 3. Free hosting for the hackathon

| Piece | Host (free tier) | Why |
|---|---|---|
| API and keeper | **Render**, one free web service | Long-running process, supports SSE. Render's free tier doesn't include background workers, so the API and keeper run in **one process** (decision 4). |
| Postgres | **Supabase**, free project | Plain Postgres with no compute-hour cap. Neon's free plan caps compute at 100 CU-hours a month; a keeper that polls all day keeps the database awake and would run through that. |
| Frontend (`apps/web`, from Day 12) | **Vercel**, Hobby plan | Next.js host; static pages and client-side calls to the API. |

**Keeping the service awake.** Render's free web service sleeps after 15 minutes without traffic and takes about a minute to wake. A free uptime monitor (for example UptimeRobot) calls `GET /health` every 5 minutes, which keeps it awake and also alerts us if it goes down. Because of decision 2, a sleep only delays the keeper; it doesn't lose anything.

**Connecting Render to Supabase.** Supabase's direct connection is IPv6-only on the free plan, and Render connects over IPv4. Use Supabase's **session pooler** connection string (IPv4, port 5432). Don't use the transaction pooler (port 6543): `pg-boss` needs session features that it doesn't support.

**Free-tier limits to watch (check on the dashboards, they change):**
- Render: the free instance hours per month must cover one service running all month; free services can be restarted at any time.
- Supabase: 500 MB database; a free project pauses after a week with no activity. The keeper's activity prevents that while it runs, but restart it (or unpause the project) if the service was down for a week.

**Arena runs stay off the free host.** A rating run starts its own anvil chain, which doesn't fit comfortably in a free instance's memory. For the hackathon, ratings run on a developer machine (`pnpm arena ...`) and the results (report, attestation, dataset rows) are published to the live database. The live API serves stored reports, scores and quotes. `POST /arena/runs` answers "not available on this host" until the service moves to a paid machine (decision 7).

### 4. One Docker image, two roles

- `apps/api` and `apps/keeper` stay separate packages with their own tests.
- One `Dockerfile` builds both. `ROLE=all` (the default) runs both in one process, which is what Render runs. `ROLE=api` or `ROLE=keeper` runs one, for local development or a paid host later.
- The keeper sends its events to the API in-process when they share a process, and through Postgres `LISTEN/NOTIFY` when they don't. The API turns them into SSE events.

### 5. Deploys

- Render deploys from GitHub **on every merge to `main`**. The founder merges every PR, so nothing reaches the live service without review.
- CI is paused (billing issue), so the full pipeline still runs on a fresh clone before each PR is opened, and the results go in the PR description.
- Migrations run on start (decision 1). A failed migration stops the service from starting instead of running with a broken schema.

### 6. Secrets

Set in each host's own environment settings, never in the repo:
- `DATABASE_URL`
- `ATTESTER_KEY`: signs attestations and quotes (Section 14.1 already put it in an environment secret for the hackathon; a KMS or threshold signer comes later).
- `KEEPER_KEY`: pays gas for `fileClaim`, `accrue` and attestation posting. It holds only testnet gas money and no special rights, since those calls are permissionless.
- RPC URLs per chain.

All keys are testnet-only. `.env.example` lists every variable as each one is added in code.

### 7. Free until validated, then scale

We don't spend on hosting before the product is validated. The free setup is enough for the hackathon demo. We move to paid hosting when any of these happens:
- we win or raise funding;
- real users or partners depend on the live service, so cold starts or outages matter;
- we want live Arena runs from the web app (the free host can't run them);
- a free-tier limit is actually hit.

The first paid step is one small VPS (for example a DigitalOcean 4 GB Droplet, about $24 a month as of September 2026) running `docker compose` with Postgres, the image and Caddy for HTTPS. It needs no code changes (Consequences below).

## Consequences

- **Cost:** $0 for the hackathon. The price is cold starts and a single process for both services.
- **Moving hosts needs no code changes.** If a free tier stops being enough, the same image runs on any Docker host (a paid Render instance, Fly.io, or an Oracle Cloud Always Free VM with `docker compose`) with `ROLE=api` and `ROLE=keeper` as separate services.
- **What isn't covered:** there's no high availability. If Render is down, the API is down. Claims are still safe (decision 2), but the live feed and quotes are unavailable until it comes back.
- **To verify before relying on it:** the free-tier limits in decision 3 come from the providers' pages as of September 2026. Check them again when the accounts are created.
