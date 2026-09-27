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
| `apps/demo-agents` | Demo AI trading agents; `vulnerable-agent` (scripted or Claude brain) |
| `attacks/` | Attack library: YAML seeds by class |
| `docs/` | Plan, decision records, daily progress notes |

More packages (API, keeper, web, SDK, Sentinel, Solana programs) arrive as the build progresses.

## Development

Requirements: Node 22, pnpm 10, [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
git clone --recursive https://github.com/ddboy19912/bonded
cd bonded
pnpm install

pnpm typecheck        # TypeScript
pnpm lint
pnpm test             # Vitest
pnpm contracts:test   # forge test
pnpm demo:local       # anvil: deploy everything, then run register → cover → breach → claim

pnpm build                                        # build the TypeScript packages first
pnpm --filter @bonded/arena arena run            # every attack vs vulnerable-agent, fresh local chain
pnpm --filter @bonded/arena arena run --fork robinhood --attack A6-operator-impersonation-001
```

`--brain claude` runs the Claude-powered agent (needs `ANTHROPIC_API_KEY`); `--list` shows the attack library. See [ADR-005](docs/decisions/005-arena-core.md).

Live testnet addresses are in [`contracts/evm/deployments/`](contracts/evm/deployments/README.md). To deploy, run from `contracts/evm` with `DEPLOYER_PRIVATE_KEY` set: `script/deploy.sh <rpc>`. See [ADR-004](docs/decisions/004-registry-disputes-bounties.md) and [`docs/progress/DAY-04.md`](docs/progress/DAY-04.md).

If you cloned without `--recursive`, run `git submodule update --init --recursive` before building the contracts.
