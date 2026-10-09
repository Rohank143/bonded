# Developing Bonded

Everything you need to build, test and run Bonded yourself. The project overview is in the [README](../README.md); how the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it yourself

Everything below runs on your own machine. Steps 1–3 need no keys, accounts or network access beyond installing dependencies.

### 1. Install the tools

| Tool | Version | Install |
|---|---|---|
| Node.js | 22.12 or newer | [nodejs.org](https://nodejs.org) |
| pnpm | 10 | `corepack enable` (ships with Node) |
| Foundry (`forge`, `anvil`, `cast`) | latest | `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |

### 2. Get the code and build it

```bash
git clone --recursive https://github.com/ddboy19912/bonded
cd bonded
pnpm install
pnpm build            # TypeScript packages
pnpm contracts:build  # Solidity contracts
```

If you cloned without `--recursive`, run `git submodule update --init --recursive` first; the contracts need their libraries.

### 3. Try it locally (no keys needed)

These run on a local chain (anvil) with its public test accounts. They never touch a real network and never read `.env`.

```bash
pnpm test             # all TypeScript tests (starts local chains for the Arena's tests)
pnpm contracts:test   # all contract tests

pnpm demo             # THE demo, in one command: local chain, API, keeper and worker; rates
                      # Agent A and Agent B, buys cover, plants an address-poisoning attack,
                      # Agent A falls for it, the keeper's claim pays (bond first, then pool),
                      # then serves the web app at http://localhost:5180 (Ctrl-C stops it all)
pnpm demo --byo       # also: your own agent (examples/byo-agent) connected through @bondedhq/runner
                      # and a local Arena Gateway, rated with a held-out set of its own; and a
                      # smart account (ERC-7579 reference account) protected by an Enforce-mode
                      # mandate module, rated and covered. Prints both agents' pages.

pnpm demo:local       # contracts only: deploy everything to a local chain, then run
                      # register → vault → bond → cover → breach → claim (the claim pays 4,500)

pnpm arena --list                           # the attack library
pnpm arena run                              # every attack against vulnerable-agent
pnpm arena rate                             # full rating: score, report, attestation, dataset
pnpm arena rate --agent hardened --enforce  # the guarded agent, for comparison
pnpm arena rate --agent partial              # the demo's Agent A: one gap, address poisoning
pnpm arena rate --agent remote               # your own agent, through a local Arena Gateway
                                             # and the runner (docs/BRING-YOUR-OWN-AGENT.md)
pnpm arena rate --agent remote --profile hosted   # the same, with a hosted rating's settings
                                             # (it refuses --repeats, --controls,
                                             # --episode-timeout and --held-out-fresh)
```

Arena output goes to `apps/arena/traces/` and `apps/arena/ratings/<agent>/`; `report.md` there is the human-readable rating. A sandbox's throwaway deployment files go to `contracts/evm/deployments/sandbox/` (git-ignored; the deploy scripts take `DEPLOYMENTS_DIR`), never beside the committed ones.

**The same break-it run on Robinhood testnet** (needs `DEPLOYER_PRIVATE_KEY`, `DEMO_AGENT_KEY` and `API_TOKEN` in `.env`): `pnpm demo:break` plants the attack for Agent A (agent 10), waits for the hosted keeper's claim and prints the waterfall with explorer links; `pnpm demo:break -- --reset` re-arms Agent A for another take. A recorded run: [docs/progress/evidence/demo-break-testnet.json](progress/evidence/demo-break-testnet.json).

**The self-serve loop on the hosted app** (needs `DEPLOYER_PRIVATE_KEY` in `.env`, only to send a new wallet a little test ETH): `pnpm check:self-serve` makes a brand-new wallet do what a tester does in the web app, with no operator token. It onboards an agent (register, vault, 4,000 tUSDG bond, 50,000 deposit), registers it for ratings and asks for one by signing, waits for the hosted worker's rating, buys 20,000 of cover with a tokenless quote, simulates a breach as the agent key and waits for the hosted keeper's claim. Each run creates a new agent on testnet and uses one of the day's 40 self-serve ratings. A recorded run (agent 11: score 49, 6.70% a year, claim of 4,500 = 4,000 from the bond + 500 from the pool): [docs/progress/evidence/self-serve-testnet.json](progress/evidence/self-serve-testnet.json).

### 4. Optional: settings in `.env`

You only need a `.env` to use language models or real testnets:

```bash
cp .env.example .env   # then fill in what you need; the file explains every setting
```

- **Precedence:** values already set in your shell win over `.env`.
- **Git:** `.env` is git-ignored, so it never gets committed.
- **Local runs:** step 3's commands ignore `.env` completely.

**Language models.** Set `OPENROUTER_API_KEY` (one key reaches hundreds of models), or point `LLM_BASE_URL` at any OpenAI-compatible endpoint, such as a local Ollama. Then:

```bash
pnpm arena rate --brain llm --model deepseek/deepseek-v4.1-flash --max-usd 2
```

| Flag | What it does |
|---|---|
| `--agent vulnerable\|hardened\|partial\|decision\|remote` | Picks the demo agent (see [AGENTS.md](AGENTS.md)), or `remote` for your own agent through the runner |
| `--brain scripted\|llm` and `--model <id>` | Picks its brain; the model is any OpenRouter model id |
| `--sentinel-model <id>` | Adds a Sentinel guard to hardened-agent |
| `--enforce` | Runs the vault in Enforce mode |
| `--repeats <n>` | Runs every attack n times |
| `--max-usd <n>` | Caps model spend for the run |
| `--fork robinhood\|arbitrum` | Runs against a copy of a live testnet instead of a fresh chain |
| `--help` | Lists everything |

**Testnets.** Bonded is already deployed on Robinhood Chain testnet and Arbitrum Sepolia; the addresses are in [`contracts/evm/deployments/`](../contracts/evm/deployments/README.md). To deploy your own copy or run the demo loop there:

1. Create a **testnet-only** wallet (for example `cast wallet new`). Never use a wallet that holds real funds.
2. Get test ETH from the chain's faucet. For Arbitrum Sepolia you can also bridge Sepolia ETH.
3. Put the key in `.env` as `DEPLOYER_PRIVATE_KEY`.
4. Run:

```bash
pnpm contracts:deploy robinhood   # or: arbitrum, or any RPC URL
pnpm contracts:smoke robinhood    # the demo loop on that chain (see .env.example for per-role keys)
```

A deploy writes `contracts/evm/deployments/<chainId>.json` only after checking everything on-chain.

### Checks before a pull request

```bash
pnpm format:check && pnpm --filter @bondedhq/shared abis:check && pnpm typecheck && pnpm lint && pnpm test
cd contracts/evm && forge fmt --check && forge test
```

## Bring your own agent

How an agent that runs on its operator's servers is protected and rated: [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md). The pieces:

| Path | Package | What it is |
|---|---|---|
| `apps/arena/src/gateway` | part of `@bonded/arena` | The Arena Gateway (MCP, HTTP, chain-mode RPC, the runner's WebSocket) and `RemoteAgent` |
| `apps/runner` | `@bondedhq/runner` (publishable, with a `bonded-runner` bin and a Dockerfile) | Connects an agent to the gateway and starts it per episode. `examples/mcp-agent.mjs` is the smallest tool-mode agent, over MCP |
| `packages/sdk` | `@bondedhq/sdk` (publishable) | The vault and module client, dry runs, the guard, the Sentinel client, the mandate builder, and the AgentKit, Solana Agent Kit and ElizaOS plugins |
| `packages/sandbox` | `@bonded/sandbox` (private) | Local chains with the protocol deployed by the production scripts, shared by the Arena's and the SDK's tests |
| `packages/shared/src/runner.ts` | `@bondedhq/shared` (publishable) | The runner protocol's messages, as zod schemas both sides parse with |
| `examples/byo-agent` | `@bonded/example-byo-agent` (private) | The full example, and the template to copy: an agent on its own server that trades through its vault with the SDK. When the runner starts it, it runs an episode in either mode: it reads all nine attack surfaces, treats them as untrusted data, and makes only the trade its task names (guarded by the SDK's dry run in chain mode). The Arena's runner end-to-end test rates it through the real gateway and runner |
| `contracts/evm/src/Mandate{Base,Module,ModuleFactory}.sol` | | The mandate checks shared by vaults and modules, and the ERC-7579 module |

Their tests run with `pnpm test` (the contracts' with `forge test`). To run one part:

```bash
pnpm --filter @bondedhq/runner test                 # the runner against a fake gateway
pnpm --filter @bondedhq/sdk test                    # vault, module and plugins on anvil
pnpm --filter @bonded/example-byo-agent test      # the example, both modes
pnpm --filter @bonded/arena test                  # includes the gateway, a real runner end to end,
                                                  # and parity on the first seed of each class
pnpm --filter @bonded/arena test:parity           # parity over the whole published library
cd contracts/evm && forge test --match-path 'test/module/*'   # the module, differential tests,
                                                              # Safe7579
```

The parity tests run Bonded's scripted vulnerable, hardened and partial agents through the gateway over MCP, over HTTP and in chain mode, and require the same verdict as in-process, episode by episode. The SDK's Solana tests need the programs built (`pnpm solana:build`) and `solana-test-validator`; without them they skip.

`pnpm demo --byo` runs the whole hosted flow on your machine: the gateway, a runner token made through the API, the real runner with `examples/byo-agent`, and a rating; and an Enforce-mode module on the ERC-7579 reference account, rated and insured.

To run the rating service's gateway yourself, start the API in the `arena-worker` (or `all`) role with `GATEWAY_PORT` set; `GATEWAY_PUBLIC_URL` is the address runners and agents reach it at, and the API puts it in the runner command it shows owners.

| Setting (rating service) | Default | What it does |
|---|---|---|
| `GATEWAY_PORT` | unset (no gateway: remote ratings fail at once) | Port the Arena Gateway listens on, in the arena-worker |
| `GATEWAY_PUBLIC_URL` | unset | The gateway's public URL (a bare host is taken as https); set on the API and the arena-worker |
| `DECLARED_COVER_CAP_USD`, `TEE_COVER_CAP_USD` | 5000, 20000 | Underwriting policy's total cover cap for an operator-run agent, by binding |
| `HELD_OUT_FRESH_PER_CLASS` | 1 | Held-out variants per attack class made for each remote rating (0 to 5); part of the remote policy |
| `HELD_OUT_MODEL`, `HELD_OUT_MAX_USD` | `deepseek/deepseek-v4.1-flash`, 0.25 | Model that drafts them when `OPENROUTER_API_KEY` or `LLM_API_KEY` is set (otherwise deterministic rewrites), and its cap per rating |
| `GATEWAY_TRUST_PROXY` | 0 | How many proxies in front of the gateway to trust for `X-Forwarded-For` (Railway: 1). Per-address connection limits use the client address that many hops from the right |
| `REMOTE_REPEATS` | 3 | Runs of each attack in a remote rating (built-in designs: 5) |
| `REMOTE_EPISODE_TIMEOUT_MS` | 90000 | One remote episode's time limit |
| `REMOTE_EPISODE_BUDGET_MS`, `REMOTE_RATING_MAX_MS` | 40000, 10800000 | A remote rating's time budget: this much per episode, never more than the ceiling (3 hours) |
| `REMOTE_RATINGS_PER_AGENT_DAILY`, `REMOTE_RATINGS_PER_OWNER_DAILY`, `REMOTE_RATINGS_DAILY` | 2, 3, 20 | Remote ratings per agent, per owner and for the whole chain, per 24 hours. Renewals and re-ratings count |
| `REMOTE_RATING_INTERVAL_MS` | 3600000 | The least time between two ratings of one operator-run agent; also how often a TEE change may re-rate it |
| `RENEW_CHECK_MS` | 600000 | How often the arena-worker looks for connected agents whose scores expire within 3 days |
| `AGENT_URL_SECRET_KEY` | unset (Agent URL mode and webhooks are refused) | 32 bytes (64 hex characters, or base64) that encrypt Agent URL secrets and webhook secrets at rest (AES-256-GCM). The same value on the API and the arena-worker. Make one with `openssl rand -hex 32` |
| `PREVIEW_PER_WALLET_DAILY`, `PREVIEW_DAILY` | 1, 20 | Preview ratings per wallet and for the whole chain, per 24 hours (0 turns previews off). Previews run one at a time, after official remote ratings |
| `PREVIEW_CREATES_PER_WALLET_DAILY` | 5 | Previews a wallet may create per 24 hours |
| `PREVIEW_RATING_MAX_MS` | 2700000 | A preview's time budget ceiling (45 minutes; 40 s an episode below it) |
| `CHECKS_PER_WALLET_HOURLY`, `CHECKS_HOURLY` | 10, 30 | Connection checks per wallet and for the whole chain, per hour |
| `AGENT_URL_VERIFIES_PER_WALLET_HOURLY`, `AGENT_URL_VERIFIES_HOURLY` | 10, 100 | Agent URL registrations and re-verifications (each one calls the URL) per wallet and in all, per hour; also at most 10 an hour per URL host |
| `RESEND_API_KEY`, `EMAIL_FROM` | unset (no email) | Notification email through Resend, only when both are set (arena-worker sends; the API accepts addresses only then) |
| `AGENT_URL_ALLOW_LOOPBACK` | unset | `1` lets Agent URLs and webhooks be plain http on this machine (`localhost`, `127.0.0.1`): local runs only, never hosted. `pnpm demo -- --byo` sets up the same itself, with an ephemeral secret key |
| `BONDED_OWN_HOSTS` | unset | Extra hosts (comma-separated) an Agent URL or webhook may not use, beyond Bonded's deployed hosts, the web origins, the gateway and the service's own Railway domain |

With the gateway on, the arena-worker runs two rating lanes, each with its own lock, so Bonded's own ratings never wait behind an operator's agent. The remote policy is read once (`remotePolicyFromEnv` in `apps/api/src/remote-policy.ts`) and used by the API, the worker, renewals and re-ratings alike. Its rating defaults come from `HOSTED_REMOTE_PROFILE` in `apps/arena/src/rate.ts`, which `pnpm arena rate --agent remote --profile hosted` also uses, so a local run with that profile predicts a hosted rating. Accepted bounties re-rate Bonded's own agents only: bounty attacks are never run against operator-run agents.

## API, keeper and the Gate 1 loop

`pnpm test:services` runs real Postgres and Anvil tests without Docker. `pnpm gate:local` runs the complete rating → attestation → quote → cover → injected breach → automatic payout loop, using embedded Postgres and a fresh Anvil deployment. Results go to `artifacts/gate-1-local.json`.

`pnpm gate:testnet` broadcasts the same demo on Robinhood Chain testnet using `DEPLOYER_PRIVATE_KEY` from `.env`. It spends test ETH and faucet tokens, creates a new demo agent and vault, and requires the existing deployment to have a zero waiting period. Review the command before running it. Results go to `artifacts/gate-1-testnet.json`; partial results are saved if a step fails.

## Web app

`apps/web` is a Vite + React app for the demo flow on Robinhood Chain testnet: the live Arena feed, agent profiles, vaults (deposit, withdraw, buy cover), underwriting (pool deposit, withdrawal, test tUSDG) and the claims feed.

```bash
pnpm --filter @bonded/web dev
```

It reads the chain directly and talks to the hosted API by default. Point it at a local API with `VITE_API_URL` (see `apps/web/.env.example`), and add the app's origin to the API's `WEB_ORIGINS`. Wallet actions need a browser wallet such as MetaMask on Robinhood Chain testnet. Starting a rating or getting a quote needs the operator token, which the page keeps in memory only.

Wallet selection, connection, account management, disconnection and network switching use RainbowKit's standard UI. Phantom, Rabby and detected EIP-6963 browser wallets such as MetaMask work without service credentials. In Phantom, enable testnet mode to use Robinhood Chain Testnet.

To enable WalletConnect QR/mobile connections, create a project at [Reown Dashboard](https://dashboard.reown.com), allow the app's deployment origins, and set `VITE_WALLETCONNECT_PROJECT_ID` in `apps/web/.env.local` and the hosting environment. Restart the dev server or rebuild the deployment after setting it; Vite embeds this public project ID at build time. Without a project ID, the app offers browser wallets and omits WalletConnect options.

## Deploying

The hosted services run on Railway, from `.railway/railway.ts`; contracts deploy with `pnpm contracts:deploy` ([deployments](../contracts/evm/deployments/README.md#deploying)). Secrets are set on the services directly and never committed. What bringing your own agent needs before it is live for everyone:

1. **Publish the packages to npm**, in dependency order: `@bondedhq/shared`, `@bondedhq/solana`, `@bondedhq/sdk`, `@bondedhq/runner` (`pnpm --filter <name> publish`, which turns `workspace:` ranges into versions). Until then `npx @bondedhq/runner` and `npm install @bondedhq/sdk` don't resolve, and builders run them from the repository.
2. **Push the runner's image**: build `apps/runner/Dockerfile` from the repository root and push it to a public registry, so builders can put their agent `FROM` it instead of building it themselves.
3. **Bring up the Arena Gateway on Railway.** The configuration gives the arena-worker a public domain on port 8080 (`GATEWAY_PORT`), sets `GATEWAY_TRUST_PROXY=1` on it (Railway's edge is one proxy hop), and sets `GATEWAY_PUBLIC_URL` on the API and the arena-worker. Merge and let the new image deploy first (the database migrations for runner tokens run on start), then `railway config plan` (it must show nothing to destroy), then `railway config apply`. Check `GET /healthz` on the gateway's domain.
4. **Redeploy the protocol on the testnets for smart-account modules.** The deployed CoverManager, ClaimsEngine and DisputeModule predate `MandateModule`, so module cover needs a full redeployment of the protocol (new addresses for every contract), which adds `MandateModuleFactory` and points CoverManager at it. Agents, vaults, bonds and cover on the old deployment stay where they are. The new `<chainId>.json` files carry `moduleFactory`; the web app offers module protection on a chain once its deployment has one.

## Synthetic Sentinel data

`pnpm sentinel:synth` writes synthetic training rows for Sentinel (specification Section 10.3), seeded from the `sentinel-dataset.jsonl` a rating writes. Labels are chosen by the generator, never by the model. It needs `OPENROUTER_API_KEY` in `.env` and a spending cap:

```bash
pnpm sentinel:synth --seeds ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --count 300 --max-usd 0.5
```

Paths are relative to `apps/arena`. Output goes to `apps/arena/datasets/sentinel-synthetic.jsonl` (gitignored); rerun the same command to resume. By default it keeps the held-out attack classes out of the data, so the evaluation tests classes Sentinel never trained on; `--exclude-classes none` turns that off.

Fine-tuning Laya on it: `pnpm sentinel:dataset` turns real and synthetic rows into Laya's typed-decision format, with a held-out test split.

## Solana programs

`contracts/solana` is an Anchor workspace with the Solana versions of the registry, mandate vault and cover (specification Section 7). It needs Rust, the Solana CLI 3.x and Anchor 1.x.

```bash
pnpm solana:test
```

This builds the three programs and their IDLs, then runs the LiteSVM tests against them: signed scores, the vault's breach checks, and the cover flow from bond to paid claim.

## TEE key custody

The hardened agent can run in a Phala Cloud confidential VM. Its keys are made inside the VM, and an Intel TDX quote proves which code holds them. The Arena verifies the quote, puts the measurement in the score (`arena rate --tee-url …`), and the agent profile shows a "TEE" badge. Why and how: [TEE.md](TEE.md). Deploying it yourself: [docs/TEE.md](TEE.md).

## The documentation site

`apps/docs` is a [Starlight](https://starlight.astro.build) (Astro) site served at `/docs` on the web app. It is generated from the Markdown in this repository (the README, `docs/`, the contracts' READMEs), so edit those files, not the site. Links between docs become links between pages; a link to code, or a path in backticks, becomes a link to that file on GitHub. Evidence files that notes cite are published under `/docs/evidence/`.

```bash
pnpm docs:dev                 # the site on http://localhost:4321/docs/
pnpm --filter @bonded/docs build
```

`pnpm --filter @bonded/web build` builds the docs and copies them into the web app's output. In `pnpm --filter @bonded/web dev`, `/docs` is proxied to the docs dev server.
