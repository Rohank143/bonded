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

pnpm demo:local       # contracts only: deploy everything to a local chain, then run
                      # register → vault → bond → cover → breach → claim (the claim pays 4,500)

pnpm arena --list                           # the attack library
pnpm arena run                              # every attack against vulnerable-agent
pnpm arena rate                             # full rating: score, report, attestation, dataset
pnpm arena rate --agent hardened --enforce  # the guarded agent, for comparison
pnpm arena rate --agent partial              # the demo's Agent A: one gap, address poisoning
```

Arena output goes to `apps/arena/traces/` and `apps/arena/ratings/<agent>/`; `report.md` there is the human-readable rating.

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
| `--agent vulnerable\|hardened\|partial\|decision` | Picks the demo agent (see [AGENTS.md](AGENTS.md)) |
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

Design records: [ADR-004](decisions/004-registry-disputes-bounties.md) (registry and deploys), [ADR-005](decisions/005-arena-core.md) (Arena), [ADR-006](decisions/006-provider-neutral-llm.md) (language models), [ADR-007](decisions/007-ratings.md) (ratings).

## API, keeper and the Gate 1 loop

`pnpm test:services` runs real Postgres and Anvil tests without Docker. `pnpm gate:local` runs the complete rating → attestation → quote → cover → injected breach → automatic payout loop, using embedded Postgres and a fresh Anvil deployment. Results go to `artifacts/gate-1-local.json`.

`pnpm gate:testnet` broadcasts the same demo on Robinhood Chain testnet using `DEPLOYER_PRIVATE_KEY` from `.env`. It spends test ETH and faucet tokens, creates a new demo agent and vault, and requires the existing deployment to have a zero waiting period. Review the command before running it. Results go to `artifacts/gate-1-testnet.json`; partial results are saved if a step fails.

**The held-out attack set** (ADR-007, decision 3). It needs `OPENROUTER_API_KEY` in `.env`, and `API_TOKEN` for the upload:
- `pnpm heldout:generate -- --max-usd 2` drafts new attacks and keeps those that pass the checks. They're written as YAML to `~/.config/bonded/held-out/<date>`, outside the repository; keep that folder private.
- `pnpm heldout:upload -- --dir <that folder>` sends them to the hosted API with a 90-day retirement date.
- `arena rate --held-out <that folder>` includes them in a local rating, as the leaderboard ratings do.

Long-running service setup and API requests: [docs/SERVICES.md](SERVICES.md). Day 7 evidence and the Section 25 checklist: [docs/progress/DAY-07.md](progress/DAY-07.md).

## Web app

`apps/web` is a Vite + React app for the demo flow on Robinhood Chain testnet: the live Arena feed, agent profiles, vaults (deposit, withdraw, buy cover), underwriting (pool deposit, withdrawal, test tUSDG) and the claims feed ([ADR-010](decisions/010-web-app.md)).

```bash
pnpm --filter @bonded/web dev
```

It reads the chain directly and talks to the hosted API by default. Point it at a local API with `VITE_API_URL` (see `apps/web/.env.example`), and add the app's origin to the API's `WEB_ORIGINS`. Wallet actions need a browser wallet such as MetaMask on Robinhood Chain testnet. Starting a rating or getting a quote needs the operator token, which the page keeps in memory only.

Wallet selection, connection, account management, disconnection and network switching use RainbowKit's standard UI. Phantom, Rabby and detected EIP-6963 browser wallets such as MetaMask work without service credentials. In Phantom, enable testnet mode to use Robinhood Chain Testnet.

To enable WalletConnect QR/mobile connections, create a project at [Reown Dashboard](https://dashboard.reown.com), allow the app's deployment origins, and set `VITE_WALLETCONNECT_PROJECT_ID` in `apps/web/.env.local` and the hosting environment. Restart the dev server or rebuild the deployment after setting it; Vite embeds this public project ID at build time. Without a project ID, the app offers browser wallets and omits WalletConnect options. Library versions and the choice of RainbowKit are documented in [Wallet integration research](WALLET-INTEGRATION-RESEARCH.md).

## Synthetic Sentinel data

`pnpm sentinel:synth` writes synthetic training rows for Sentinel (plan Section 10.3), seeded from the `sentinel-dataset.jsonl` a rating writes. Labels are chosen by the generator, never by the model. It needs `OPENROUTER_API_KEY` in `.env` and a spending cap:

```bash
pnpm sentinel:synth --seeds ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --count 300 --max-usd 0.5
```

Paths are relative to `apps/arena`. Output goes to `apps/arena/datasets/sentinel-synthetic.jsonl` (gitignored); rerun the same command to resume. By default it keeps the held-out attack classes, A7 and A10 (`SENTINEL_HELD_OUT_CLASSES`), out of the data, so Day 10's evaluation tests classes Sentinel never trained on; `--exclude-classes none` turns that off. Results and limits of the first run: [docs/progress/DAY-08.md](progress/DAY-08.md).

Fine-tuning Laya on it: `pnpm sentinel:dataset` turns real and synthetic rows into Laya's typed-decision format, with a held-out test split, and [services/sentinel/kaggle/README.md](../services/sentinel/kaggle/README.md) walks through running Laya's own Kaggle notebook on it.

## Solana programs

`contracts/solana` is an Anchor workspace with the Solana versions of the registry, mandate vault and cover (plan Section 7, [ADR-011](decisions/011-solana-programs.md)). It needs Rust, the Solana CLI 3.x and Anchor 1.x.

```bash
pnpm solana:test
```

This builds the three programs and their IDLs, then runs the LiteSVM tests against them: signed scores, the vault's breach checks, and the cover flow from bond to paid claim.

## TEE key custody

The hardened agent can run in a Phala Cloud confidential VM. Its keys are made inside the VM, and an Intel TDX quote proves which code holds them. The Arena verifies the quote, puts the measurement in the score (`arena rate --tee-url …`), and the agent profile shows a "TEE" badge. Why and how: [ADR-012](decisions/012-tee-custody.md). Deploying it yourself: [docs/TEE.md](TEE.md).
