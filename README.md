# Bonded

> **Don't cage your agent. Bond it.**

Bonded rates AI agents by attacking them, then insures the people who give those agents money.

- **The Arena:** AI attacker agents red-team an agent inside a forked-chain sandbox. Pass/fail is decided by our on-chain contract, not an LLM.
- **Bonded Score:** red-team results are turned into an expected-loss estimate and a premium, and the signed score is posted on-chain (ERC-8004 compatible).
- **Mandate Vaults:** agents trade from a smart account that knows their rules. It either blocks breaches or records them on-chain.
- **Cover:** when an agent breaks its mandate, the operator's bond is slashed first, then the underwriting pool pays depositors automatically, within minutes.
- **Bonded Sentinel:** a 33 ms real-time guard built on the open-source Laya decision model, fine-tuned on Arena data.

Built for the Colosseum Crypto World's Fair on **Robinhood Chain, Arbitrum, Ethereum and Solana**.

📄 **Full product and build plan:** [`docs/PLAN.md`](docs/PLAN.md)

## Status

Building. The build runs Sep 27 – Oct 11, 2026. See the day-by-day plan in [`docs/PLAN.md` Section 20](docs/PLAN.md#20-16-day-build-plan) and daily notes in [`docs/progress/`](docs/progress/).

## Repo layout

| Path | What's there |
|---|---|
| `packages/shared` | Schemas (mandate, attack spec, attestation, quote), chain configs, tiers, EIP-712 types, deployment files |
| `contracts/evm` | Solidity contracts (Foundry), deploy and smoke scripts, live addresses. **Start with [its README](contracts/evm/README.md)** for what each contract does. |
| `apps/arena` | The Arena: red-teams an agent in a local or forked-chain sandbox and judges it by the vault's breach log |
| `apps/demo-agents` | Demo AI trading agents; `vulnerable-agent` (scripted or LLM brain, any model) |
| `attacks/` | Attack library: YAML seeds by class |
| `docs/` | Plan, decision records, daily progress notes |

More packages (API, keeper, web, SDK, Sentinel, Solana programs) arrive as the build progresses.

## Run it yourself

Everything below runs on your own machine. Steps 1–3 need no keys, accounts or network access beyond installing dependencies.

### 1. Install the tools

| Tool | Version | Install |
|---|---|---|
| Node.js | 22 or newer | [nodejs.org](https://nodejs.org) |
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

pnpm demo:local       # deploy everything to a local chain, then run
                      # register → vault → bond → cover → breach → claim (the claim pays 4,500)

pnpm arena --list                           # the attack library
pnpm arena run                              # every attack against vulnerable-agent
pnpm arena rate                             # full rating: score, report, attestation, dataset
pnpm arena rate --agent hardened --enforce  # the guarded agent, for comparison
```

Arena output goes to `apps/arena/traces/` and `apps/arena/ratings/<agent>/`; `report.md` there is the human-readable rating.

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
| `--agent vulnerable\|hardened\|decision` | Picks the demo agent |
| `--brain scripted\|llm` and `--model <id>` | Picks its brain; the model is any OpenRouter model id |
| `--sentinel-model <id>` | Adds a Sentinel guard to hardened-agent |
| `--enforce` | Runs the vault in Enforce mode |
| `--repeats <n>` | Runs every attack n times |
| `--max-usd <n>` | Caps model spend for the run |
| `--fork robinhood\|arbitrum` | Runs against a copy of a live testnet instead of a fresh chain |
| `--help` | Lists everything |

**Testnets.** Bonded is already deployed on Robinhood Chain testnet and Arbitrum Sepolia; the addresses are in [`contracts/evm/deployments/`](contracts/evm/deployments/README.md). To deploy your own copy or run the demo loop there:

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
pnpm format:check && pnpm --filter @bonded/shared abis:check && pnpm typecheck && pnpm lint && pnpm test
cd contracts/evm && forge fmt --check && forge test
```

Design records: [ADR-004](docs/decisions/004-registry-disputes-bounties.md) (registry and deploys), [ADR-005](docs/decisions/005-arena-core.md) (Arena), [ADR-006](docs/decisions/006-provider-neutral-llm.md) (language models), [ADR-007](docs/decisions/007-ratings.md) (ratings).
