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

## Not done: the testnet deploy

The scripts are ready for Robinhood Chain testnet (46630) and Arbitrum Sepolia (421614), but this container can't do the deploy:
- The network policy blocks both RPCs (403 from the proxy).
- There is no funded deployer key.

Once both are in place, the deploy is one command per chain, run from `contracts/evm`:

```bash
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com/rpc --broadcast
forge script script/Deploy.s.sol --rpc-url https://sepolia-rollup.arbitrum.io/rpc --broadcast
```

`DEPLOYER_PRIVATE_KEY` comes from the environment secret. The smoke script needs `WAITING_PERIOD=0` on the deploy (or a separate short-waiting deployment) plus `OPERATOR_KEY`, `AGENT_KEY`, `USER_KEY` and `ATTESTER_KEY`. The resulting JSON files get committed.

## Changes to the plan

- Section 6.2: rows for BondedRegistry, OperatorBond, ClaimsEngine, DisputeModule and BountyBoard updated to what was built.
- Section 6.4: `buyCover` also checks that the caller owns the agent in the registry.
- Section 13.1: the bounty commitment includes the hunter's address.
- Section 15: new paragraph on the testnet demo market.
- Section 20, Day 4: addresses live in `contracts/evm/deployments/` and are read through `@bonded/shared`.

## Blockers

- **Testnet deploy (Day 4, carried to Day 7's gate):** allowlist `rpc.testnet.chain.robinhood.com` and `sepolia-rollup.arbitrum.io` in the environment's network settings, and add a testnet-only deployer key as an environment secret (`DEPLOYER_PRIVATE_KEY`), funded from the faucets.
- **Anthropic API key (Day 5):** unchanged.

## Next (Day 5)

Arena core: fork sandbox, world simulator (news, social, DMs, prices, metadata, tool output), episode runner with the vault breach log as the judge, and `vulnerable-agent` v0. Done when one attack class runs end to end on a fork with a correct verdict.

## Review asks

- Check the dispute trust assumptions in ADR-004 (the council can reject any unchallenged proposal; dispute payouts aren't tied to breach records).
- Check that transferring an agent NFT should transfer operator rights, including the bond.
- Check the 250 tUSDG proposal bond and the 2-day challenge period.
