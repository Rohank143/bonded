# Day 4: Registry, disputes, bounties and deploy scripts

Plan reference: docs/PLAN.md Section 20, Day 4. Design record: `docs/decisions/004-registry-disputes-bounties.md`.

## Done

- **`BondedRegistry`:**
  - ERC-8004-aligned agent identities: ERC-721 agents, `register(...)` overloads, agent URI and key/value metadata.
  - The token owner is the operator; OperatorBond and CoverManager read it from here.
  - Holds the attester set that CoverManager and BountyBoard check.
  - `postScore` takes a signed attestation from anyone (so the keeper can relay one score to every chain). It rejects expired, unsigned and stale scores, and emits an ERC-8004-style `ValidationResponse`.
- **`OperatorBond` and `CoverManager` now use the registry:**
  - Anyone can stake for a registered agent; only its owner can withdraw.
  - Binding cover requires the caller to be both the vault's guardian and the agent's owner.
- **`DisputeModule`:**
  - Optimistic path for grey-area (T4) claims: propose with a bond, challenge within 2 days, council decides.
  - An unchallenged proposal pays through ClaimsEngine's normal waterfall after the deadline.
  - `ClaimsEngine.payDispute` only accepts the DisputeModule, which is set once.
- **`BountyBoard`:**
  - Commit-reveal attack submissions bound to the hunter's address.
  - Registry attesters accept (paying from the 5% premium share) or reject.
- **Testnet demo market (`src/testnet/`):**
  - `TestToken`: tUSDG (6 decimals) and tTSLA/tAMZN/tNVDA (18 decimals) with capped faucets.
  - `DemoRouter`: swaps at the oracle price minus 0.2%.
- **Scripts:**
  - `Deploy.s.sol` deploys the market and the protocol, wires every module and writes `deployments/<chainId>.json`.
  - `Smoke.s.sol` runs the demo loop against that file.
  - `pnpm demo:local` runs both on anvil. It refuses a busy port 8545 and cleans up anvil afterwards.
- **`@bonded/shared`:** `parseEvmDeployment` validates deployment files, checksums addresses and rejects a file for the wrong chain.
- **Tests:** 156 Forge tests (29 new: registry 10, disputes 8, bounties 5, testnet contracts 3, plus 3 in CoverManager and OperatorBond for the registry wiring) and 47 TypeScript tests (4 new).

## Local deploy and smoke run

`pnpm demo:local`, from a clean anvil:

| Step | Result |
|---|---|
| Deploy (market + 8 protocol contracts, wired) | `deployments/31337.json` written |
| Register agent, create vault, stake 10,000 bond | agent 1 |
| Underwriter deposits 500,000; depositor deposits 40,000 | |
| Attester signs quote; operator binds 20,000 cover | policy 1 |
| Allowed swap: 1,000 tUSDG → tTSLA through the router | no breach |
| Agent sends 5,000 tUSDG to an attacker | breach recorded (loss 5,000), agent frozen |
| Anyone files the claim | **4,500 paid** into the vault from the bond; bond left 5,500 |

## Testnet deploy (done Sep 27)

This container couldn't reach the testnet RPCs, so the founder ran `Deploy.s.sol` locally with a fresh testnet-only deployer (`0xd42FA5ae8949710479954ae78D1b12Ff2e50A841`, funded from the Google Cloud Sepolia faucet and bridged to Arbitrum Sepolia). Both deployments were then checked on-chain from here:
- all 14 contracts have code
- the modules are wired to each other
- the waiting period is 0
- the deployer is registry owner and attester
- the router holds its liquidity

| Chain | Deploy block | Gas spent |
|---|---|---|
| Robinhood Chain testnet (46630) | 125,384,720 | ~0.00025 ETH |
| Arbitrum Sepolia (421614) | 313,403,556 | ~0.0008 ETH |

The addresses are the same on both chains, because the deployer had sent no transactions on either before. They're listed in `contracts/evm/deployments/README.md`.

Things the deploy exposed, fixed in the follow-up PR:
- **Dry runs wrote files.** `Deploy.s.sol` wrote `deployments/<chainId>.json` during dry runs, leaving addresses that were never deployed. It now writes only when broadcasting.
- **Wrong block number on Arbitrum.** `block.number` is the Ethereum Sepolia block there, so `deployedAtBlock` read the chain's RPC instead.
- **Smoke keys.** `Smoke.s.sol` now falls back to `DEPLOYER_PRIVATE_KEY` for every role, so one funded key runs the loop on a testnet.

## Changes to the plan

- Section 6.2: rows for BondedRegistry, OperatorBond, ClaimsEngine, DisputeModule and BountyBoard updated to what was built.
- Section 6.4: `buyCover` also checks that the caller owns the agent in the registry.
- Section 13.1: the bounty commitment includes the hunter's address.
- Section 15: new paragraph on the testnet demo market.
- Section 20, Day 4: addresses live in `contracts/evm/deployments/` and are read through `@bonded/shared`.

## Blockers

- **Testnet smoke run:** the founder runs `Smoke.s.sol` on both chains (see `contracts/evm/deployments/README.md`).
- **Anthropic API key (Day 5):** unchanged.

## Next (Day 5)

Arena core: fork sandbox, world simulator (news, social, DMs, prices, metadata, tool output), episode runner with the vault breach log as the judge, and `vulnerable-agent` v0. Done when one attack class runs end to end on a fork with a correct verdict.

## Review asks

- Check the dispute trust assumptions in ADR-004 (the council can reject any unchallenged proposal; dispute payouts aren't tied to breach records).
- Check that transferring an agent NFT should transfer operator rights, including the bond.
- Check the 250 tUSDG proposal bond and the 2-day challenge period.
