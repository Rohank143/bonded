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
| `packages/shared` | Schemas (mandate, attack spec, attestation, quote), chain configs, tiers, EIP-712 types |
| `contracts/evm` | Solidity contracts (Foundry) |
| `docs/` | Plan, decision records, daily progress notes |

More packages (Arena, API, keeper, web, Sentinel, Solana programs) arrive as the build progresses.

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
```

If you cloned without `--recursive`, run `git submodule update --init --recursive` before building the contracts.
