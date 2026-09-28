# ADR-010: Web app

- **Status:** Accepted
- **Date:** 2026-09-29
- **Code:** `apps/web/`, CORS in `apps/api/src/index.ts`

## Context

Day 8 needs the demo flow clickable in a browser against Robinhood Chain testnet: the Arena live feed, agent profile, vault, underwriting and claims pages (plan Section 14.4). The plan named Next.js (App Router) with shadcn/ui. The founder chose a plain Vite + React app instead.

## Decisions

### 1. A Vite + React single-page app, not Next.js

- **Stack:** Vite, React, TypeScript, React Router, Tailwind, wagmi and viem, TanStack Query.
- **Why:** every page is client-side: it reads the chain and the public API and signs with the user's wallet. Nothing needs server rendering, and the long-lived work (SSE, the keeper, ratings) already runs on Railway (ADR-008). A static build has fewer moving parts and deploys anywhere, including Vercel's static hosting.
- **shadcn/ui is not used.** A handful of small components in `src/components/ui.tsx` cover the pages; they can be swapped later without changing the pages' data code.
- The Solana wallet adapter comes with the Solana work (Days 9 and 10), not here.

### 2. Reads come from the chain; the API only supplies what the chain can't

- **From the chain (viem, through wagmi):** registry scores, bonds, vault state and breach logs, policies, pool figures, and `ClaimPaid` / `VaultCreated` / `CoverBound` logs. The testnet RPC answers a log query from the deployment block to the head in under a second, so no indexer or new list endpoint is needed.
- **From the API:** the live episode feed (SSE), run status and reports, the latest attestation's transaction and run ID, and signed quotes.
- The deployment file (`contracts/evm/deployments/46630.json`) is imported at build time, so the app always matches the contracts the services use.

### 3. Operator actions need the operator token, held in memory

`POST /arena/runs` and `POST /quotes` require the API token (Day 7). That stays: a public page must not let anyone spend the attester's gas or have it sign quotes. Anyone can browse; to start a rating or get a quote, the operator pastes the token into the page. It lives in React state for that tab only: never in storage or a URL. Binding the quote on chain still needs the vault guardian's wallet, which `CoverManager` checks.

### 4. The API allows browser origins from an allowlist

The API now answers CORS requests from origins in `WEB_ORIGINS` (comma-separated). Everything else gets no CORS headers, so other sites' pages can't read responses. The CORS layer runs before the token check, so a browser can read a 401. Railway sets `WEB_ORIGINS` for local development today; the hosted web app's URL is added when it is deployed (plan Day 12).

## Consequences

- `docs/PLAN.md` Sections 5, 14.4 and 16 and ADR-008 now say Vite + React.
- The service image no longer builds the web app (`turbo run build --filter=!@bonded/web`).
- **Not yet done:** a hosted deployment, per-page code splitting (the JavaScript is one 876 kB chunk, 246 kB gzipped), and wallet transactions exercised by hand in a browser with a wallet. The transaction calls were checked by simulating them against testnet.
- The SSE endpoint admits five subscribers per API instance (Day 7). A busy public page would hit that limit; raise it or add a fan-out before wide sharing.
